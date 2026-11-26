import type { AgentMessenger } from "../agent/commands";
import { desiredStates, pushChanges } from "../agent/reconcile";
import { newFingerprint, simpleUUID } from "../crypto";
import type { ChainTunnelRow, ForwardPortRow, PanelDB } from "../db/queries";
import { FINGERPRINT_KEY, FINGERPRINT_RE } from "../db/schema";
import {
  fail,
  notBlank,
  notNull,
  numInt,
  numPtr,
  ok,
  paramInt,
  paramStr,
  parseNum,
  parsePorts,
  parseStr,
  processServerAddress,
  type R,
  strPtr,
  throwBiz,
  validatePortRange,
} from "../utils/validation";

export interface NodeRouteDeps {
  db: PanelDB;
  messenger: AgentMessenger;
  releaseRepo: string;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  deleteTunnelInternal(tunnelId: number): Promise<void>;
}

export function handleNodeCreate(db: PanelDB, body: Record<string, unknown>): R {
  const name = parseStr(body.name);
  const serverIp = parseStr(body.serverIp);
  const port = parseStr(body.port);
  const interfaceName = parseStr(body.interfaceName);
  notBlank(name, "节点名称不能为空");
  notBlank(serverIp, "服务器ip不能为空");
  notBlank(port, "可用端口不能为空");
  validatePortRange(port.v);
  const now = Date.now();
  db.sql.exec(
    `INSERT INTO node (name, secret, server_ip, port, interface_name, created_time, updated_time, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    name.v,
    simpleUUID(),
    serverIp.v,
    port.v,
    strPtr(interfaceName),
    now,
    now,
  );
  return ok();
}

export function handleNodeList(db: PanelDB): R {
  const list = db.listNodes("ORDER BY status DESC").map((n) => ({ ...n, secret: null }));
  return ok(list);
}

function planPortMoves(
  db: PanelDB,
  nodeId: number,
  newRange: string,
): { chainMoves: Map<number, number>; portMoves: Map<number, number> } {
  const chainMoves = new Map<number, number>();
  const portMoves = new Map<number, number>();
  const ports = parsePorts(newRange);
  const allowed = new Set<number>(ports);
  const used = new Set<number>();
  const needChain: ChainTunnelRow[] = [];
  const needPort: ForwardPortRow[] = [];

  for (const ct of db.listChains("WHERE node_id = ? ORDER BY id", nodeId)) {
    if (ct.port === null) continue;
    if (allowed.has(ct.port)) {
      used.add(ct.port);
    } else if (ct.chainType !== 1) {
      needChain.push(ct);
    }
  }
  for (const fp of db.listForwardPorts("WHERE node_id = ? ORDER BY id", nodeId)) {
    if (allowed.has(fp.port)) {
      used.add(fp.port);
    } else {
      needPort.push(fp);
    }
  }

  const free = ports.filter((p) => !used.has(p));
  const need = needChain.length + needPort.length;
  if (need > free.length) {
    throwBiz(
      `新端口范围不够用：需要重新分配 ${need} 个端口（隧道 ${needChain.length} 个、转发 ${needPort.length} 个），新范围内只有 ${free.length} 个空闲端口`,
    );
  }
  let idx = 0;
  for (const ct of needChain) {
    if (ct.id !== null) chainMoves.set(ct.id, free[idx++]);
  }
  for (const fp of needPort) {
    portMoves.set(fp.id, free[idx++]);
  }
  return { chainMoves, portMoves };
}

export async function handleNodeUpdate(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = parseNum(body.id);
  const name = parseStr(body.name);
  const serverIp = parseStr(body.serverIp);
  const port = parseStr(body.port);
  const interfaceName = parseStr(body.interfaceName);
  const http = parseNum(body.http);
  const tls = parseNum(body.tls);
  const socks = parseNum(body.socks);
  const tcpListenAddr = parseStr(body.tcpListenAddr);
  const udpListenAddr = parseStr(body.udpListenAddr);

  notNull(id, "节点ID不能为空");
  notBlank(name, "节点名称不能为空");
  notBlank(serverIp, "服务器ip不能为空");
  notBlank(port, "可用port不能为空");
  validatePortRange(port.v);

  return deps.withLock(async () => {
    const node = deps.db.getNode(numInt(id));
    if (!node) return fail("节点不存在");

    const changed = (n: ReturnType<typeof parseNum>, cur: number) => n.valid && numInt(n) !== cur;
    if (
      node.status === 1 &&
      (changed(http, node.http) || changed(tls, node.tls) || changed(socks, node.socks))
    ) {
      const r = await deps.messenger.sendMsg(
        node.id,
        { http: numPtr(http), tls: numPtr(tls), socks: numPtr(socks) },
        "SetProtocol",
      );
      if (r.msg !== "OK") return fail(r.msg);
    }

    const related = deps.db.relatedNodeIds(node.id);
    const before = desiredStates(deps.db, related);
    const autoInIP = new Set<number>();
    for (const t of deps.db.tunnelsWithEntry(node.id)) {
      if (!t.inIp || t.inIp === deps.db.entryIPs(t.id)) {
        autoInIP.add(t.id);
      }
    }

    const { chainMoves, portMoves } = planPortMoves(deps.db, node.id, port.v);

    const tcp = tcpListenAddr.valid ? tcpListenAddr.v : "0.0.0.0";
    const udp = udpListenAddr.valid ? udpListenAddr.v : "0.0.0.0";
    const sets = [
      "name = ?",
      "server_ip = ?",
      "port = ?",
      "updated_time = ?",
      "tcp_listen_addr = ?",
      "udp_listen_addr = ?",
    ];
    const args: unknown[] = [name.v, serverIp.v, port.v, Date.now(), tcp, udp];
    for (const [col, v] of [
      ["http", http],
      ["tls", tls],
      ["socks", socks],
    ] as const) {
      if (v.valid) {
        sets.push(`${col} = ?`);
        args.push(numInt(v));
      }
    }
    if (interfaceName.valid) {
      sets.push("interface_name = ?");
      args.push(interfaceName.v);
    }
    args.push(node.id);
    deps.db.sql.exec(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...args);

    for (const [cid, p] of chainMoves.entries()) {
      deps.db.sql.exec("UPDATE chain_tunnel SET port = ? WHERE id = ?", p, cid);
    }
    for (const [fid, p] of portMoves.entries()) {
      deps.db.sql.exec("UPDATE forward_port SET port = ? WHERE id = ?", p, fid);
    }
    for (const tid of autoInIP) {
      deps.db.sql.exec("UPDATE tunnel SET in_ip = ? WHERE id = ?", deps.db.entryIPs(tid), tid);
    }

    const errs = await pushChanges(deps.messenger, before, desiredStates(deps.db, related));
    if (errs.length > 0) {
      return fail(
        `节点已保存，但以下配置同步失败（节点重新连接后会自动重试）：${errs.join("；")}`,
      );
    }
    return ok();
  });
}

export async function handleNodeDelete(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  return deps.withLock(async () => {
    if (!deps.db.getNode(id)) return fail("节点不存在");
    const rows = deps.db.sql
      .exec<{ tunnel_id: number }>("SELECT DISTINCT tunnel_id FROM chain_tunnel WHERE node_id = ?", id)
      .toArray();
    for (const r of rows) {
      await deps.deleteTunnelInternal(Number(r.tunnel_id));
    }
    deps.db.sql.exec("DELETE FROM node WHERE id = ?", id);
    return ok();
  });
}

export function handleNodeInstall(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
  requestUrl: string,
): R {
  const id = paramInt(body, "id");
  const node = deps.db.getNode(id);
  if (!node) return fail("节点不存在");
  let ip = deps.db.getConfigValue("ip");
  if (!ip || ip.trim() === "") {
    // 若尚未手填面板地址，自动回落到当前访问的 CF Worker 域名，开箱即用
    try {
      ip = new URL(requestUrl).origin;
    } catch {
      return fail("请先前往「系统配置」设置面板地址");
    }
  }
  const cmd =
    `curl -L https://github.com/${deps.releaseRepo}/releases/latest/download/install.sh -o ./install.sh && ` +
    `chmod +x ./install.sh && ./install.sh -a ${processServerAddress(ip)} -s ${node.secret ?? ""} -f ${deps.db.panelFingerprint()}`;
  return ok(cmd);
}

// ---------- 网站配置 & 指纹 ----------

export function handleConfigList(db: PanelDB): R {
  const rows = db.sql.exec<{ name: string; value: string }>("SELECT name, value FROM vite_config").toArray();
  const m: Record<string, string> = {};
  for (const r of rows) m[r.name] = r.value;
  return ok(m);
}

export function handleConfigGet(db: PanelDB, body: Record<string, unknown>): R {
  const name = paramStr(body, "name").trim();
  if (!name) return fail("配置名称不能为空");
  const r = db.sql
    .exec<{ id: number; name: string; value: string; time: number }>(
      "SELECT id, name, value, time FROM vite_config WHERE name = ?",
      name,
    )
    .toArray()[0];
  if (!r) return fail("配置不存在");
  return ok(r);
}

export function handleConfigUpdate(db: PanelDB, body: Record<string, unknown>): R {
  const keys = Object.keys(body);
  if (keys.length === 0) return fail("配置数据不能为空");
  for (const k of keys) {
    if (!k.trim()) continue;
    const v = body[k] === null || body[k] === undefined ? "" : paramStr(body, k);
    db.upsertConfig(k, v);
  }
  return ok();
}

export function handleConfigUpdateSingle(db: PanelDB, body: Record<string, unknown>): R {
  const name = paramStr(body, "name").trim();
  const value = paramStr(body, "value");
  if (!name) return fail("配置名称不能为空");
  if (!value.trim()) return fail("配置值不能为空");
  db.upsertConfig(name, value);
  return ok();
}

export function handleFingerprintGet(db: PanelDB): R {
  return ok({ fingerprint: db.panelFingerprint() });
}

export function handleFingerprintSave(db: PanelDB, body: Record<string, unknown>): R {
  const fpStr = parseStr(body.fingerprint);
  const regenerate = Boolean(body.regenerate);
  let fp = fpStr.v.trim();
  if (regenerate) fp = newFingerprint();
  if (!FINGERPRINT_RE.test(fp)) {
    return fail("指纹必须是 8 位英文字母或数字");
  }
  db.setSetting(FINGERPRINT_KEY, fp);
  return ok({ fingerprint: fp });
}

// ---------- 节点流量上报策略（双触发 + 噪点过滤，实时下发所有在线节点） ----------

export const FLOW_POLICY_INTERVAL_KEY = "flow_report_interval_min";
export const FLOW_POLICY_THRESHOLD_KEY = "flow_report_threshold_mb";
export const FLOW_POLICY_MIN_KB_KEY = "flow_report_min_kb";

export const DEFAULT_FLOW_INTERVAL_MIN = 10;
export const DEFAULT_FLOW_THRESHOLD_MB = 1024;
export const DEFAULT_FLOW_MIN_KB = 64;

export interface FlowReportPolicy {
  intervalMin: number;
  thresholdMb: number;
  minKb: number;
  flowIntervalSec: number;
  flowThresholdBytes: number;
  flowMinBytes: number;
}

function parseIntSetting(raw: string, fallback: number, min: number, max: number): number {
  const t = raw.trim();
  if (t === "" || !/^\d+$/.test(t)) return fallback;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function loadFlowReportPolicy(db: PanelDB): FlowReportPolicy {
  const intervalMin = parseIntSetting(
    db.getSetting(FLOW_POLICY_INTERVAL_KEY),
    DEFAULT_FLOW_INTERVAL_MIN,
    1,
    60,
  );
  const thresholdMb = parseIntSetting(
    db.getSetting(FLOW_POLICY_THRESHOLD_KEY),
    DEFAULT_FLOW_THRESHOLD_MB,
    0,
    102400,
  );
  const minKb = parseIntSetting(db.getSetting(FLOW_POLICY_MIN_KB_KEY), DEFAULT_FLOW_MIN_KB, 0, 10240);
  return {
    intervalMin,
    thresholdMb,
    minKb,
    flowIntervalSec: intervalMin * 60,
    flowThresholdBytes: thresholdMb * 1024 * 1024,
    flowMinBytes: minKb * 1024,
  };
}

export function handleFlowPolicyGet(db: PanelDB, onlineNodes: number): R {
  return ok({ ...loadFlowReportPolicy(db), onlineNodes });
}

export function handleFlowPolicySave(
  db: PanelDB,
  body: Record<string, unknown>,
  pushPolicy: (policy: FlowReportPolicy) => number,
): R {
  const iv = parseNum(body.intervalMin);
  const th = parseNum(body.thresholdMb);
  const mk = parseNum(body.minKb);
  if (!iv.valid || numInt(iv) < 1 || numInt(iv) > 60) {
    return fail("上报间隔必须为 1–60 之间的整数（分钟）");
  }
  if (!th.valid || numInt(th) < 0 || numInt(th) > 102400) {
    return fail("流量快报阈值必须为 0–102400 之间的整数（MB，0 表示关闭）");
  }
  if (!mk.valid || numInt(mk) < 0 || numInt(mk) > 10240) {
    return fail("噪点过滤阈值必须为 0–10240 之间的整数（KB，0 表示不过滤）");
  }

  db.setSetting(FLOW_POLICY_INTERVAL_KEY, String(numInt(iv)));
  db.setSetting(FLOW_POLICY_THRESHOLD_KEY, String(numInt(th)));
  db.setSetting(FLOW_POLICY_MIN_KB_KEY, String(numInt(mk)));

  const policy = loadFlowReportPolicy(db);
  const pushedNodes = pushPolicy(policy);
  return ok({ ...policy, pushedNodes });
}

// ---------- 节点端远程一键更新 ----------

export type UpgradeStatusKind =
  | "idle"
  | "started"
  | "downloading"
  | "verifying"
  | "restarting"
  | "success"
  | "up_to_date"
  | "unsupported"
  | "offline"
  | "failed";

export interface NodeUpgradeState {
  status: UpgradeStatusKind;
  message: string;
  fromVersion?: string;
  toVersion?: string;
  updatedAt: number;
}

export interface LatestReleaseInfo {
  latestVersion: string;
  releaseUrl: string;
  publishedAt: string;
}

export interface ReleaseCache {
  value: LatestReleaseInfo | null;
  fetchedAt: number;
}

export function normalizeVersion(v?: string | null): string {
  return (v ?? "").trim().replace(/^v/i, "");
}

/** 1.04 及以上版本的节点端内置了 UpgradeAgent 远程更新指令 */
export function supportsRemoteUpgrade(version?: string | null): boolean {
  const clean = normalizeVersion(version);
  if (!clean) return false;
  const m = /^(\d+)\.(\d+)/.exec(clean);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 4);
}

const RELEASE_CACHE_TTL_MS = 10 * 60_000;

function extractTagFromReleaseUrl(rawUrl: string): string {
  const m = /\/releases\/tag\/([^/?#]+)/i.exec(rawUrl);
  return m ? decodeURIComponent(m[1]) : "";
}

export function parseReleaseAtom(xml: string, repo: string): LatestReleaseInfo | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(xml)?.[1];
  if (!entry) return null;
  const href = /<link[^>]*href="([^"]+)"/i.exec(entry)?.[1] ?? "";
  const idVal = /<id>([^<]+)<\/id>/i.exec(entry)?.[1] ?? "";
  const titleVal = /<title>([^<]+)<\/title>/i.exec(entry)?.[1] ?? "";
  const updatedVal = /<updated>([^<]+)<\/updated>/i.exec(entry)?.[1] ?? "";
  const tagFromHref = extractTagFromReleaseUrl(href);
  const tagFromId = idVal.split("/").pop()?.trim() ?? "";
  const rawTag = tagFromHref || tagFromId || titleVal.trim();
  const latestVersion = normalizeVersion(rawTag);
  if (!latestVersion) return null;
  return {
    latestVersion,
    releaseUrl: href.startsWith("http")
      ? href
      : `https://github.com/${repo}/releases/tag/${encodeURIComponent(rawTag)}`,
    publishedAt: updatedVal.trim(),
  };
}

/**
 * 获取最新 Release 版本号：
 * 1) 优先使用 github.com/<repo>/releases/latest 的 302 Location 跳转头（零 API 限流）
 * 2) 次选 github.com/<repo>/releases.atom（同样零 API 限流，且包含发布时间）
 * 3) 最后兜底 api.github.com；成功结果默认缓存 10 分钟。
 */
export async function fetchLatestReleaseInfo(
  repo: string,
  cache: ReleaseCache,
  forceRefresh = false,
): Promise<LatestReleaseInfo & { fetchError?: string }> {
  const now = Date.now();
  if (!forceRefresh && cache.value && now - cache.fetchedAt < RELEASE_CACHE_TTL_MS) {
    return cache.value;
  }
  const latestPageUrl = `https://github.com/${repo}/releases/latest`;
  let lastErr = "";

  // 1. 主路径：HEAD/GET /releases/latest (redirect: manual) 读取 302 Location，零 API 限流
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const resp = await fetch(latestPageUrl, {
        method,
        redirect: "manual",
        headers: { "User-Agent": "ForwardZ-CF-Panel" },
        signal: AbortSignal.timeout(8_000),
      });
      const loc = resp.headers.get("location") || resp.url || "";
      await resp.body?.cancel().catch(() => {});
      const tag = extractTagFromReleaseUrl(loc);
      if (tag) {
        const releaseUrl = loc.startsWith("http") ? loc : `https://github.com${loc}`;
        const info: LatestReleaseInfo = {
          latestVersion: normalizeVersion(tag),
          releaseUrl,
          publishedAt: "",
        };
        cache.value = info;
        cache.fetchedAt = now;
        return info;
      }
      lastErr = `GitHub 跳转响应异常 (HTTP ${resp.status})`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  // 2. 次选路径：releases.atom 公开订阅源，无 GitHub REST API 限流
  try {
    const resp = await fetch(`https://github.com/${repo}/releases.atom`, {
      headers: {
        "User-Agent": "ForwardZ-CF-Panel",
        Accept: "application/atom+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      const xml = await resp.text();
      const parsed = parseReleaseAtom(xml, repo);
      if (parsed) {
        cache.value = parsed;
        cache.fetchedAt = now;
        return parsed;
      }
      lastErr = "GitHub releases.atom 未解析到版本";
    } else {
      lastErr = `GitHub Atom HTTP ${resp.status}`;
    }
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e);
  }

  // 3. 兜底路径：仅当前两路均异常时回退到 GitHub REST API
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        "User-Agent": "ForwardZ-CF-Panel",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      throw new Error(`GitHub API HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
    };
    const info: LatestReleaseInfo = {
      latestVersion: normalizeVersion(data.tag_name),
      releaseUrl: data.html_url || latestPageUrl,
      publishedAt: data.published_at || "",
    };
    cache.value = info;
    cache.fetchedAt = now;
    return info;
  } catch (e) {
    const err = lastErr || (e instanceof Error ? e.message : String(e));
    if (cache.value) {
      return { ...cache.value, fetchError: err };
    }
    return {
      latestVersion: "",
      releaseUrl: latestPageUrl,
      publishedAt: "",
      fetchError: err,
    };
  }
}

export interface NodeUpgradeDeps {
  db: PanelDB;
  messenger: AgentMessenger;
  releaseRepo: string;
  releaseCache: ReleaseCache;
  upgradeStates: Map<number, NodeUpgradeState>;
}

export async function handleNodeUpgradeInfo(
  deps: NodeUpgradeDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const refresh = Boolean(body.refresh);
  const rel = await fetchLatestReleaseInfo(deps.releaseRepo, deps.releaseCache, refresh);
  const nodes = deps.db.listNodes("ORDER BY status DESC, id ASC").map((n) => {
    const online = deps.messenger.nodeOnline(n.id);
    const curVer = normalizeVersion(n.version);
    const supported = supportsRemoteUpgrade(curVer);
    const needsUpgrade = Boolean(rel.latestVersion && curVer && curVer !== rel.latestVersion);
    const state = deps.upgradeStates.get(n.id);
    return {
      id: n.id,
      name: n.name,
      status: online ? 1 : 0,
      version: curVer || n.version || "",
      supportsRemoteUpgrade: supported,
      needsUpgrade,
      upgradeState: state ?? null,
    };
  });
  return ok({
    repo: deps.releaseRepo,
    latestVersion: rel.latestVersion,
    releaseUrl: rel.releaseUrl,
    publishedAt: rel.publishedAt,
    fetchError: rel.fetchError ?? "",
    nodes,
  });
}

export async function handleNodeUpgradeAll(
  deps: NodeUpgradeDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const force = Boolean(body.force);
  const rawIds = Array.isArray(body.nodeIds)
    ? body.nodeIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
    : null;

  let targetVersion = normalizeVersion(parseStr(body.targetVersion).v);
  if (!targetVersion) {
    const rel = await fetchLatestReleaseInfo(deps.releaseRepo, deps.releaseCache, false);
    targetVersion = rel.latestVersion;
  }

  const allNodes = deps.db.listNodes("ORDER BY id ASC");
  const targets = rawIds
    ? allNodes.filter((n) => rawIds.includes(n.id))
    : allNodes.filter((n) => deps.messenger.nodeOnline(n.id));

  if (targets.length === 0) {
    return fail("当前没有可更新的在线节点");
  }

  const results = await Promise.all(
    targets.map(async (node) => {
      const curVer = normalizeVersion(node.version);
      if (!deps.messenger.nodeOnline(node.id)) {
        const st: NodeUpgradeState = {
          status: "offline",
          fromVersion: curVer,
          toVersion: targetVersion,
          message: "节点离线",
          updatedAt: Date.now(),
        };
        return { nodeId: node.id, name: node.name, ...st };
      }

      if (!supportsRemoteUpgrade(curVer)) {
        const st: NodeUpgradeState = {
          status: "unsupported",
          fromVersion: curVer,
          toVersion: targetVersion,
          message: `当前版本 ${curVer || "未知"} 不支持远程一键更新，请先在节点 SSH 执行一次 zf 升级至 1.04+`,
          updatedAt: Date.now(),
        };
        deps.upgradeStates.set(node.id, st);
        return { nodeId: node.id, name: node.name, ...st };
      }

      if (!force && targetVersion && curVer === targetVersion) {
        const st: NodeUpgradeState = {
          status: "up_to_date",
          fromVersion: curVer,
          toVersion: targetVersion,
          message: `已是最新版本 ${targetVersion}`,
          updatedAt: Date.now(),
        };
        deps.upgradeStates.set(node.id, st);
        return { nodeId: node.id, name: node.name, ...st };
      }

      const r = await deps.messenger.sendMsg(
        node.id,
        { repo: deps.releaseRepo, targetVersion, force },
        "UpgradeAgent",
      );
      if (r.msg !== "OK") {
        const st: NodeUpgradeState = {
          status: "failed",
          fromVersion: curVer,
          toVersion: targetVersion,
          message: r.msg || "下发升级指令失败",
          updatedAt: Date.now(),
        };
        deps.upgradeStates.set(node.id, st);
        return { nodeId: node.id, name: node.name, ...st };
      }

      const remoteStatus = String(r.data?.status ?? "started");
      if (remoteStatus === "up_to_date") {
        const st: NodeUpgradeState = {
          status: "up_to_date",
          fromVersion: curVer,
          toVersion: String(r.data?.toVersion ?? curVer),
          message: `已是最新版本 ${String(r.data?.toVersion ?? curVer)}`,
          updatedAt: Date.now(),
        };
        deps.upgradeStates.set(node.id, st);
        return { nodeId: node.id, name: node.name, ...st };
      }

      const st: NodeUpgradeState = {
        status: "started",
        fromVersion: curVer,
        toVersion: targetVersion,
        message: "已下发升级指令，等待节点下载并重启...",
        updatedAt: Date.now(),
      };
      deps.upgradeStates.set(node.id, st);
      return { nodeId: node.id, name: node.name, ...st };
    }),
  );

  return ok({
    targetVersion,
    results,
  });
}
