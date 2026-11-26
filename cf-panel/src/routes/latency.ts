import type { PanelDB } from "../db/queries";
import { fail, numInt, ok, parseNum, type R } from "../utils/validation";

/**
 * 5 分钟分桶聚合延迟存储（latency_bucket）：
 * - 每次批量探测无论包含多少条隧道/转发，只合并写 1 行 SQLite（无二级索引），将高频 10s/20s/30s/1m 的写行降到极低。
 * - 24h 内最多 ~288 行，读取与聚合 CPU < 1.5ms，绝不触碰 CF Free Plan 10ms CPU 上限。
 * - 最近 2 个 5 分钟桶保留原始子采样点 pts（上限 30 个），刚开启 10s 高频采集也能立刻画出细腻实时波形；更早的桶自动剥离 pts 仅保留精确聚合统计。
 */

export const LATENCY_RETENTION_MS = 25 * 3600_000;
export const LATENCY_BUCKET_MS = 5 * 60_000;
export const DEFAULT_LATENCY_PROBE_INTERVAL_SEC = 60;
export const MIN_LATENCY_PROBE_INTERVAL_SEC = 10;
export const MAX_LATENCY_PROBE_INTERVAL_SEC = 3600;
export const LATENCY_PROBE_INTERVAL_SEC_KEY = "latency_probe_interval_sec";
export const LATENCY_PROBE_INTERVAL_LEGACY_KEY = "latency_probe_interval_min";
export const LATENCY_PROBE_LAST_KEY = "latency_probe_last_ms";

export interface LatencyPoint {
  t: number;
  ms: number;
  loss: number;
  ok: boolean;
}

export interface LatencySummary {
  tunnelId?: number;
  forwardId?: number;
  minLatency: number | null;
  avgLatency: number | null;
  maxLatency: number | null;
  latestLatency: number | null;
  packetLoss: number | null;
  sampleCount: number;
  points: LatencyPoint[];
}

export interface LatencySampleInput {
  key: string; // "t:<tunnelId>" 或 "f:<forwardId>"
  ms: number;
  loss: number;
  ok: boolean;
  t?: number;
}

interface BucketEntry {
  n: number;
  ok: number;
  sum: number;
  min: number;
  max: number;
  ls: number;
  lt: number;
  lm: number;
  ll: number;
  lo: 0 | 1;
  pts?: Array<[number, number, number]>; // [t, ms(-1 if fail), loss]
}

type BucketMap = Record<string, BucketEntry>;

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function clampLoss(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

export function loadLatencyProbeIntervalSec(db: PanelDB): number {
  const rawSec = db.getSetting(LATENCY_PROBE_INTERVAL_SEC_KEY);
  if (rawSec !== "") {
    const n = parseInt(rawSec, 10);
    if (!Number.isFinite(n)) return DEFAULT_LATENCY_PROBE_INTERVAL_SEC;
    if (n <= 0) return 0;
    return Math.max(MIN_LATENCY_PROBE_INTERVAL_SEC, Math.min(MAX_LATENCY_PROBE_INTERVAL_SEC, n));
  }
  // 兼容旧版按分钟保存的配置
  const rawMin = db.getSetting(LATENCY_PROBE_INTERVAL_LEGACY_KEY);
  if (rawMin !== "") {
    const m = parseInt(rawMin, 10);
    if (Number.isFinite(m)) {
      if (m <= 0) return 0;
      return Math.max(MIN_LATENCY_PROBE_INTERVAL_SEC, Math.min(MAX_LATENCY_PROBE_INTERVAL_SEC, m * 60));
    }
  }
  return DEFAULT_LATENCY_PROBE_INTERVAL_SEC;
}

export function handleLatencyPolicyGet(db: PanelDB): R {
  const intervalSec = loadLatencyProbeIntervalSec(db);
  const lastProbeTime = parseInt(db.getSetting(LATENCY_PROBE_LAST_KEY), 10) || 0;
  return ok({
    intervalSec,
    defaultIntervalSec: DEFAULT_LATENCY_PROBE_INTERVAL_SEC,
    intervalMin: intervalSec > 0 ? Math.max(1, Math.round(intervalSec / 60)) : 0,
    lastProbeTime,
  });
}

export function handleLatencyPolicySave(db: PanelDB, body: Record<string, unknown>): R {
  const secParam = parseNum(body.intervalSec);
  const minParam = parseNum(body.intervalMin);
  let sec: number;
  if (secParam.valid) {
    sec = numInt(secParam);
  } else if (minParam.valid) {
    sec = numInt(minParam) * 60;
  } else {
    return fail("请填写有效的探测间隔");
  }
  if (sec !== 0 && (sec < MIN_LATENCY_PROBE_INTERVAL_SEC || sec > MAX_LATENCY_PROBE_INTERVAL_SEC)) {
    return fail("探测间隔需为 0（关闭自动探测）或 10 秒–60 分钟");
  }
  db.setSetting(LATENCY_PROBE_INTERVAL_SEC_KEY, String(sec));
  const lastProbeTime = parseInt(db.getSetting(LATENCY_PROBE_LAST_KEY), 10) || 0;
  return ok({
    intervalSec: sec,
    defaultIntervalSec: DEFAULT_LATENCY_PROBE_INTERVAL_SEC,
    intervalMin: sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0,
    lastProbeTime,
  });
}

function parseBucketMap(raw: string): BucketMap {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as BucketMap;
    }
  } catch {
    // 忽略损坏 JSON
  }
  return {};
}

function mergeSample(map: BucketMap, s: LatencySampleInput, fallbackNow: number): void {
  const t = s.t ?? fallbackNow;
  const okFlag = s.ok && Number.isFinite(s.ms) && s.ms >= 0;
  const ms = okFlag ? round1(s.ms) : -1;
  const loss = okFlag ? round1(clampLoss(s.loss)) : 100;

  let e = map[s.key];
  if (!e) {
    e = {
      n: 0,
      ok: 0,
      sum: 0,
      min: -1,
      max: -1,
      ls: 0,
      lt: t,
      lm: ms,
      ll: loss,
      lo: okFlag ? 1 : 0,
      pts: [],
    };
    map[s.key] = e;
  }
  e.n += 1;
  e.ls = round1(e.ls + loss);
  if (okFlag) {
    e.ok += 1;
    e.sum = round1(e.sum + ms);
    e.min = e.min < 0 ? ms : Math.min(e.min, ms);
    e.max = e.max < 0 ? ms : Math.max(e.max, ms);
  }
  if (t >= e.lt) {
    e.lt = t;
    e.lm = ms;
    e.ll = loss;
    e.lo = okFlag ? 1 : 0;
  }
  if (!e.pts) e.pts = [];
  e.pts.push([t, ms, loss]);
  if (e.pts.length > 36) {
    e.pts.splice(0, e.pts.length - 36);
  }
}

/**
 * 将一批隧道/转发探测样本合并写入当前 5 分钟桶（仅 1 次 SQLite 写入）。
 * 仅在首次切换到新的 5 分钟桶时，顺带清理 25h 过期桶并剥离 10 分钟前旧桶的原始 pts，确保读表永远 < 1.5ms CPU。
 */
export function recordLatencySamples(
  db: PanelDB,
  samples: LatencySampleInput[],
  nowMs = Date.now(),
): void {
  if (samples.length === 0) return;
  const bucketMs = Math.floor(nowMs / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
  const existing = db.sql
    .exec<{ data: string }>("SELECT data FROM latency_bucket WHERE bucket_ms = ?", bucketMs)
    .toArray()[0];

  const isNewBucket = !existing;
  const map = existing ? parseBucketMap(existing.data) : {};
  for (const s of samples) {
    mergeSample(map, s, nowMs);
  }

  db.sql.exec(
    `INSERT INTO latency_bucket (bucket_ms, data) VALUES (?, ?)
     ON CONFLICT(bucket_ms) DO UPDATE SET data = excluded.data`,
    bucketMs,
    JSON.stringify(map),
  );

  // 每 5 分钟仅在新建桶时执行一次维护：删 25h 过期桶 + 剥离旧桶原始子点以瘦身 JSON
  if (isNewBucket) {
    const cutoff = nowMs - LATENCY_RETENTION_MS;
    db.sql.exec("DELETE FROM latency_bucket WHERE bucket_ms < ?", cutoff);
    const stripBefore = bucketMs - LATENCY_BUCKET_MS * 2;
    const oldRows = db.sql
      .exec<{ bucket_ms: number; data: string }>(
        "SELECT bucket_ms, data FROM latency_bucket WHERE bucket_ms <= ? AND data LIKE '%\"pts\":%'",
        stripBefore,
      )
      .toArray();
    for (const r of oldRows) {
      const m = parseBucketMap(r.data);
      let changed = false;
      for (const k of Object.keys(m)) {
        if (m[k].pts !== undefined) {
          delete m[k].pts;
          changed = true;
        }
      }
      if (changed) {
        db.sql.exec("UPDATE latency_bucket SET data = ? WHERE bucket_ms = ?", JSON.stringify(m), r.bucket_ms);
      }
    }
  }
}

export function purgeLatencyKey(db: PanelDB, key: string): void {
  const rows = db.sql
    .exec<{ bucket_ms: number; data: string }>(
      "SELECT bucket_ms, data FROM latency_bucket WHERE data LIKE ?",
      `%"${key}"%`,
    )
    .toArray();
  for (const r of rows) {
    const m = parseBucketMap(r.data);
    if (Object.prototype.hasOwnProperty.call(m, key)) {
      delete m[key];
      db.sql.exec("UPDATE latency_bucket SET data = ? WHERE bucket_ms = ?", JSON.stringify(m), r.bucket_ms);
    }
  }
}

/**
 * 从 5 分钟分桶表中构造精确的 24h 统计（最快 / 平均 / 最慢 / 丢包率）和波形点列表。
 * - 若条目历史不足 4 个 5 分钟桶（刚开启高频探测），自动展开原始 10s/20s/30s 子采样点，让波形立刻动起来；
 * - 若历史 ≥ 4 个桶，输出平滑的 5 分钟聚合点（24h 最多 288 点，与 SVG 像素 1:1 匹配）。
 */
export function buildBucketLatencyHistory(
  db: PanelDB,
  prefix: "t" | "f",
  hours = 24,
  allowedIds?: Set<number> | null,
  onlyId?: number,
): Record<string, LatencySummary> {
  const clampedHours = Math.max(1, Math.min(48, Math.trunc(hours) || 24));
  const since = Date.now() - clampedHours * 3600_000;
  const sinceBucket = Math.floor(since / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;

  const rows = db.sql
    .exec<{ bucket_ms: number; data: string }>(
      "SELECT bucket_ms, data FROM latency_bucket WHERE bucket_ms >= ? ORDER BY bucket_ms ASC",
      sinceBucket,
    )
    .toArray();

  interface Acc {
    id: number;
    totalN: number;
    totalOk: number;
    sumMs: number;
    sumLoss: number;
    minMs: number;
    maxMs: number;
    latestT: number;
    latestOk: boolean;
    latestMs: number;
    bucketPts: LatencyPoint[];
    rawPts: LatencyPoint[];
  }

  const accMap = new Map<number, Acc>();
  const keyPrefix = `${prefix}:`;

  for (const r of rows) {
    const bMs = Number(r.bucket_ms);
    const bMap = parseBucketMap(r.data);
    for (const [k, e] of Object.entries(bMap)) {
      if (!k.startsWith(keyPrefix)) continue;
      const id = parseInt(k.slice(keyPrefix.length), 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (onlyId !== undefined && id !== onlyId) continue;
      if (allowedIds && !allowedIds.has(id)) continue;
      if (!e || e.n <= 0) continue;

      let acc = accMap.get(id);
      if (!acc) {
        acc = {
          id,
          totalN: 0,
          totalOk: 0,
          sumMs: 0,
          sumLoss: 0,
          minMs: -1,
          maxMs: -1,
          latestT: -1,
          latestOk: false,
          latestMs: -1,
          bucketPts: [],
          rawPts: [],
        };
        accMap.set(id, acc);
      }

      acc.totalN += e.n;
      acc.totalOk += e.ok;
      acc.sumMs += e.sum;
      acc.sumLoss += e.ls;
      if (e.ok > 0) {
        if (e.min >= 0) acc.minMs = acc.minMs < 0 ? e.min : Math.min(acc.minMs, e.min);
        if (e.max >= 0) acc.maxMs = acc.maxMs < 0 ? e.max : Math.max(acc.maxMs, e.max);
      }
      if (e.lt >= acc.latestT) {
        acc.latestT = e.lt;
        acc.latestOk = e.lo === 1 && e.lm >= 0;
        acc.latestMs = acc.latestOk ? round1(e.lm) : -1;
      }

      const bOk = e.ok > 0;
      acc.bucketPts.push({
        t: e.lt || bMs,
        ms: bOk ? round1(e.sum / e.ok) : -1,
        loss: round1(clampLoss(e.ls / e.n)),
        ok: bOk,
      });

      if (Array.isArray(e.pts) && e.pts.length > 0) {
        for (const tuple of e.pts) {
          const [ptT, ptMs, ptLoss] = tuple;
          if (ptT < since) continue;
          const ptOk = ptMs >= 0;
          acc.rawPts.push({
            t: ptT,
            ms: ptOk ? round1(ptMs) : -1,
            loss: ptOk ? round1(clampLoss(ptLoss)) : 100,
            ok: ptOk,
          });
        }
      }
    }
  }

  const out: Record<string, LatencySummary> = {};
  for (const [id, acc] of accMap.entries()) {
    const useRaw = acc.bucketPts.length < 4 && acc.rawPts.length > acc.bucketPts.length;
    const points = useRaw ? acc.rawPts.slice(-60) : acc.bucketPts;
    const summary: LatencySummary = {
      ...(prefix === "t" ? { tunnelId: id } : { forwardId: id }),
      minLatency: acc.totalOk > 0 && acc.minMs >= 0 ? round1(acc.minMs) : null,
      avgLatency: acc.totalOk > 0 ? round1(acc.sumMs / acc.totalOk) : null,
      maxLatency: acc.totalOk > 0 && acc.maxMs >= 0 ? round1(acc.maxMs) : null,
      latestLatency: acc.latestOk && acc.latestMs >= 0 ? acc.latestMs : null,
      packetLoss: acc.totalN > 0 ? round1(clampLoss(acc.sumLoss / acc.totalN)) : null,
      sampleCount: acc.totalN,
      points,
    };
    out[String(id)] = summary;
  }
  return out;
}
