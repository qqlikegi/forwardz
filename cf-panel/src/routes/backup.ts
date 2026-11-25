import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { hmacSha256, sha256Hex } from "../crypto";
import type { PanelDB } from "../db/queries";
import { formatLocalCompact, nextDailyRunMs } from "../utils/timezone";
import { fail, ok, type R } from "../utils/validation";

const BACKUP_FILE_PREFIX = "forwardz-panel-backup-";

export interface BackupConfig {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
  keep: number;
  mode: "daily" | "interval";
  time: string;
  hours: number;
}

export interface S3Object {
  key: string;
  lastModified: string;
  size: number;
}

function normalizeConfig(c: Partial<BackupConfig>): BackupConfig {
  const keep = Number.isFinite(Number(c.keep)) && Number(c.keep) > 0 ? Math.trunc(Number(c.keep)) : 3;
  const hours = Number.isFinite(Number(c.hours)) && Number(c.hours) > 0 ? Math.trunc(Number(c.hours)) : 24;
  const time = typeof c.time === "string" && /^\d{2}:\d{2}$/.test(c.time) ? c.time : "03:00";
  return {
    enabled: Boolean(c.enabled),
    endpoint: (c.endpoint ?? "").trim(),
    bucket: (c.bucket ?? "").trim(),
    accessKey: (c.accessKey ?? "").trim(),
    secretKey: (c.secretKey ?? "").trim(),
    prefix: (c.prefix ?? "").trim().replace(/^\/+|\/+$/g, ""),
    keep,
    mode: c.mode === "interval" ? "interval" : "daily",
    time,
    hours,
  };
}

export function loadBackupConfig(db: PanelDB): BackupConfig {
  return normalizeConfig({
    enabled: db.getSetting("backup_enabled") === "true",
    endpoint: db.getSetting("backup_endpoint"),
    bucket: db.getSetting("backup_bucket"),
    accessKey: db.getSetting("backup_access_key"),
    secretKey: db.getSetting("backup_secret_key"),
    prefix: db.getSetting("backup_prefix"),
    keep: parseInt(db.getSetting("backup_keep"), 10) || 3,
    mode: db.getSetting("backup_mode") === "interval" ? "interval" : "daily",
    time: db.getSetting("backup_time"),
    hours: parseInt(db.getSetting("backup_hours"), 10) || 24,
  });
}

function keyPrefix(cfg: BackupConfig): string {
  return (cfg.prefix ? `${cfg.prefix}/` : "") + BACKUP_FILE_PREFIX;
}

function backupTimeSortKey(key: string): string {
  const idx = key.lastIndexOf("/");
  const base = idx >= 0 ? key.slice(idx + 1) : key;
  return base.startsWith(BACKUP_FILE_PREFIX) ? base.slice(BACKUP_FILE_PREFIX.length) : base;
}

export function nextBackupRunMs(cfg: BackupConfig, anchorMs: number, tzOffsetMin: number): number {
  if (cfg.mode === "interval") {
    return anchorMs + cfg.hours * 3600_000;
  }
  return nextDailyRunMs(anchorMs, cfg.time, tzOffsetMin);
}

// ---------- S3 SigV4 客户端（兼容 Cloudflare R2 与任意 S3） ----------

function awsEncode(s: string, keepSlash: boolean): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~" ||
      (keepSlash && ch === "/")
    ) {
      out += ch;
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${awsEncode(k, false)}=${awsEncode(params[k], false)}`)
    .join("&");
}

function signV4(
  method: string,
  host: string,
  encPath: string,
  query: string,
  payloadHash: string,
  accessKey: string,
  secretKey: string,
  region: string,
  now: Date,
): { auth: string; amzDate: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const date = iso.slice(0, 8);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${iso}\n`;
  const creq = [method, encPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${iso}\n${scope}\n${sha256Hex(creq)}`;

  let k = hmacSha256(`AWS4${secretKey}`, date);
  k = hmacSha256(k, region);
  k = hmacSha256(k, "s3");
  k = hmacSha256(k, "aws4_request");
  const sig = hmacSha256(k, sts).toString("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return { auth, amzDate: iso };
}

class S3Client {
  private readonly base: URL;
  private readonly region = "auto";

  constructor(
    endpoint: string,
    private readonly bucket: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {
    const ep = endpoint.trim();
    if (!ep) throw new Error("请填写 S3 终结点地址");
    const withProto = ep.includes("://") ? ep : `https://${ep}`;
    let parsed: URL;
    try {
      parsed = new URL(withProto);
    } catch {
      throw new Error("S3 终结点地址格式不正确");
    }
    if (!parsed.host) throw new Error("S3 终结点地址格式不正确");
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    this.base = parsed;
    if (!bucket.trim()) throw new Error("请填写存储桶名称");
    if (!accessKey.trim() || !secretKey.trim()) throw new Error("请填写访问密钥 ID 和机密访问密钥");
  }

  private async doReq(
    method: string,
    key: string,
    queryParams: Record<string, string>,
    body: Uint8Array | null,
  ): Promise<{ status: number; text: string }> {
    const path = `/${this.bucket}${key ? `/${key}` : ""}`;
    const encPath = awsEncode(path, true);
    const query = canonicalQuery(queryParams);
    const url = `${this.base.origin}${encPath}${query ? `?${query}` : ""}`;
    const payload = body ?? new Uint8Array(0);
    const payloadHash = sha256Hex(payload);
    const { auth, amzDate } = signV4(
      method,
      this.base.host,
      encPath,
      query,
      payloadHash,
      this.accessKey,
      this.secretKey,
      this.region,
      new Date(),
    );

    const headers: Record<string, string> = {
      Authorization: auth,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };
    if (method === "PUT" && key) {
      headers["Content-Type"] = "application/gzip";
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: method === "PUT" ? payload : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    return { status: resp.status, text };
  }

  private s3Error(status: number, body: string): Error {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
    const msg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? "";
    if (status === 403 || code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId") {
      return new Error(
        `没有权限（${status} ${code}）：请检查访问密钥 ID / 机密访问密钥是否正确、令牌是否有该存储桶的读写权限`,
      );
    }
    if (code) return new Error(`存储返回错误 ${status} ${code}：${msg}`);
    return new Error(`存储返回错误 ${status}`);
  }

  async ensureBucket(): Promise<boolean> {
    const head = await this.doReq("HEAD", "", {}, null);
    if (head.status === 200) return false;
    if (head.status !== 404) throw this.s3Error(head.status, head.text);
    const put = await this.doReq("PUT", "", {}, null);
    if (Math.floor(put.status / 100) !== 2) {
      throw new Error(`存储桶不存在，自动创建失败：${this.s3Error(put.status, put.text).message}`);
    }
    return true;
  }

  async list(prefix: string): Promise<S3Object[]> {
    const all: S3Object[] = [];
    let token = "";
    for (let page = 0; page < 20; page++) {
      const q: Record<string, string> = { "list-type": "2", prefix };
      if (token) q["continuation-token"] = token;
      const res = await this.doReq("GET", "", q, null);
      if (res.status !== 200) throw this.s3Error(res.status, res.text);
      const blocks = res.text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
      for (const b of blocks) {
        const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(b)?.[1] ?? "");
        const lastModified = /<LastModified>([^<]+)<\/LastModified>/.exec(b)?.[1] ?? "";
        const size = parseInt(/<Size>(\d+)<\/Size>/.exec(b)?.[1] ?? "0", 10) || 0;
        if (key) all.push({ key, lastModified, size });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(res.text);
      const next = decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(res.text)?.[1] ?? "");
      if (!truncated || !next) break;
      token = next;
    }
    all.sort((a, b) => backupTimeSortKey(a.key).localeCompare(backupTimeSortKey(b.key)));
    return all;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const res = await this.doReq("PUT", key, {}, body);
    if (Math.floor(res.status / 100) !== 2) throw this.s3Error(res.status, res.text);
  }

  async del(key: string): Promise<void> {
    const res = await this.doReq("DELETE", key, {}, null);
    if (Math.floor(res.status / 100) !== 2 && res.status !== 404) {
      throw this.s3Error(res.status, res.text);
    }
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------- SQL 快照导出（与 Go cli_db.go exportSQLTo 兼容） ----------

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer) {
    return `X'${Buffer.from(new Uint8Array(v)).toString("hex")}'`;
  }
  if (ArrayBuffer.isView(v)) {
    return `X'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function exportDatabaseSQL(db: PanelDB, version: string): string {
  const lines: string[] = [];
  lines.push(`-- ForwardZ CF Panel ${version} SQL Export ${new Date().toISOString()}`);
  lines.push("PRAGMA foreign_keys=OFF;");
  lines.push("BEGIN TRANSACTION;");

  const objs = db.sql
    .exec<{ type: string; name: string; sql: string }>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    )
    .toArray();

  for (const o of objs) {
    if (o.type !== "table") continue;
    lines.push(`${o.sql};`);
    const qTable = `"${o.name.replace(/"/g, '""')}"`;
    const rows = db.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${qTable}`).toArray();
    for (const r of rows) {
      const vals = Object.values(r).map(sqlLiteral).join(",");
      lines.push(`INSERT INTO ${qTable} VALUES(${vals});`);
    }
  }
  for (const o of objs) {
    if (o.type !== "table") {
      lines.push(`${o.sql};`);
    }
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

// ---------- 备份 HTTP 处理器与调度 ----------

export interface BackupHost {
  db: PanelDB;
  version: string;
  tzOffsetMin: number;
  scheduleNextAlarm(): Promise<void>;
}

let backupRunningFlag = false;

function formConfig(db: PanelDB, body: Record<string, unknown>): BackupConfig {
  const cfg = normalizeConfig(body as Partial<BackupConfig>);
  if (!cfg.secretKey) {
    cfg.secretKey = db.getSetting("backup_secret_key").trim();
  }
  return cfg;
}

export function handleBackupGet(host: BackupHost): R {
  const cfg = loadBackupConfig(host.db);
  const hasSecret = cfg.secretKey !== "";
  const safeCfg = { ...cfg, secretKey: "" };
  let nextRun: number | null = null;
  if (cfg.enabled) {
    const anchor = parseInt(host.db.getSetting("backup_anchor"), 10) || 0;
    if (anchor > 0) {
      nextRun = nextBackupRunMs(cfg, anchor, host.tzOffsetMin);
    }
  }
  const lastTime = parseInt(host.db.getSetting("backup_last_time"), 10) || 0;
  return ok({
    config: safeCfg,
    hasSecret,
    nextRun,
    lastTime,
    lastStatus: host.db.getSetting("backup_last_status"),
    lastMessage: host.db.getSetting("backup_last_msg"),
    running: backupRunningFlag,
  });
}

export async function handleBackupSave(host: BackupHost, body: Record<string, unknown>): Promise<R> {
  const d = formConfig(host.db, body);
  if (d.enabled) {
    try {
      new S3Client(d.endpoint, d.bucket, d.accessKey, d.secretKey);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  host.db.setSetting("backup_enabled", String(d.enabled));
  host.db.setSetting("backup_endpoint", d.endpoint);
  host.db.setSetting("backup_bucket", d.bucket);
  host.db.setSetting("backup_access_key", d.accessKey);
  host.db.setSetting("backup_secret_key", d.secretKey);
  host.db.setSetting("backup_prefix", d.prefix);
  host.db.setSetting("backup_keep", String(d.keep));
  host.db.setSetting("backup_mode", d.mode);
  host.db.setSetting("backup_time", d.time);
  host.db.setSetting("backup_hours", String(d.hours));
  host.db.setSetting("backup_anchor", String(Date.now()));
  await host.scheduleNextAlarm();
  return ok();
}

export async function handleBackupTest(host: BackupHost, body: Record<string, unknown>): Promise<R> {
  try {
    const d = formConfig(host.db, body);
    const cl = new S3Client(d.endpoint, d.bucket, d.accessKey, d.secretKey);
    const created = await cl.ensureBucket();
    const objs = await cl.list(keyPrefix(d));
    const msg = created
      ? `连接成功，存储桶 ${d.bucket} 不存在，已自动创建`
      : `连接成功，存储桶 ${d.bucket} 中已有 ${objs.length} 份备份`;
    return ok(msg);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function handleBackupList(host: BackupHost): Promise<R> {
  try {
    const cfg = loadBackupConfig(host.db);
    const cl = new S3Client(cfg.endpoint, cfg.bucket, cfg.accessKey, cfg.secretKey);
    const objs = await cl.list(keyPrefix(cfg));
    objs.reverse(); // 新的在前
    return ok(objs);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function runBackupNow(host: BackupHost): Promise<{ key: string; error?: string }> {
  if (backupRunningFlag) {
    return { key: "", error: "已有备份任务正在进行，请稍后再试" };
  }
  backupRunningFlag = true;
  let key = "";
  let errMsg: string | undefined;
  try {
    const cfg = loadBackupConfig(host.db);
    const cl = new S3Client(cfg.endpoint, cfg.bucket, cfg.accessKey, cfg.secretKey);
    await cl.ensureBucket();
    const sqlText = exportDatabaseSQL(host.db, host.version);
    const gz = gzipSync(Buffer.from(sqlText, "utf8"), { level: 6 });
    key = `${keyPrefix(cfg)}${formatLocalCompact(Date.now(), host.tzOffsetMin)}.sql.gz`;
    await cl.put(key, new Uint8Array(gz));

    const objs = await cl.list(keyPrefix(cfg));
    const delErrs: string[] = [];
    for (let i = 0; i < objs.length - cfg.keep; i++) {
      if (objs[i].key === key) continue;
      try {
        await cl.del(objs[i].key);
      } catch (e) {
        delErrs.push(`${objs[i].key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (delErrs.length > 0) {
      errMsg = `备份已上传，但删除旧备份失败：${delErrs.join("；")}`;
    }
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  } finally {
    backupRunningFlag = false;
    host.db.setSetting("backup_last_time", String(Date.now()));
    host.db.setSetting("backup_last_status", errMsg ? "failed" : "success");
    host.db.setSetting("backup_last_msg", errMsg ?? `备份成功：${key}`);
  }
  return { key, error: errMsg };
}

export async function handleBackupRun(host: BackupHost): Promise<R> {
  const r = await runBackupNow(host);
  if (r.error) return fail(r.error);
  return ok(`备份成功：${r.key}`);
}
