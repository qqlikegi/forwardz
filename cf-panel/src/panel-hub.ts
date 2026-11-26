import { DurableObject } from "cloudflare:workers";
import type { AgentMessenger, AgentResult } from "./agent/commands";
import {
  type Claims,
  decryptIfNeeded,
  encryptForNode,
  newRandomHex,
  newUUID,
  parseToken,
} from "./crypto";
import { PanelDB } from "./db/queries";
import { initDatabase } from "./db/schema";
import {
  type BackupHost,
  handleBackupGet,
  handleBackupList,
  handleBackupRun,
  handleBackupSave,
  handleBackupTest,
  loadBackupConfig,
  nextBackupRunMs,
  runBackupNow,
} from "./routes/backup";
import {
  type FlowItem,
  handleDashboardOverview,
  handleFlowConfig,
  handleFlowUpload,
  processFlowItems,
  runResetFlowTask,
  runStatisticsFlow,
} from "./routes/flow";
import {
  changeForwardStatus,
  deleteForwardInternal,
  type ForwardRouteDeps,
  handleForwardCreate,
  handleForwardDelete,
  handleForwardDiagnose,
  handleForwardForceDelete,
  handleForwardList,
  handleForwardUpdate,
  handleForwardUpdateOrder,
  handleOpenSubStore,
  handleSpeedCreate,
  handleSpeedDelete,
  handleSpeedList,
  handleSpeedUpdate,
  syncForward,
} from "./routes/forward";
import {
  handleMigrateBatch,
  handleMigrateFinalize,
  handleMigrateReset,
  handleMigrateStatus,
  verifyMigrationToken,
} from "./routes/migrate";
import {
  type FlowReportPolicy,
  handleConfigGet,
  handleConfigList,
  handleConfigUpdate,
  handleConfigUpdateSingle,
  handleFingerprintGet,
  handleFingerprintSave,
  handleFlowPolicyGet,
  handleFlowPolicySave,
  handleNodeCreate,
  handleNodeDelete,
  handleNodeInstall,
  handleNodeList,
  handleNodeUpdate,
  handleNodeUpgradeAll,
  handleNodeUpgradeInfo,
  loadFlowReportPolicy,
  type NodeRouteDeps,
  type NodeUpgradeDeps,
  type NodeUpgradeState,
  normalizeVersion,
  type ReleaseCache,
  type UpgradeStatusKind,
} from "./routes/node";
import {
  deleteTunnelInternal,
  handleTunnelCreate,
  handleTunnelDelete,
  handleTunnelDiagnose,
  handleTunnelForUser,
  handleTunnelLatencyHistory,
  handleTunnelList,
  handleTunnelProbeNow,
  handleTunnelUpdate,
  handleUserTunnelAssign,
  handleUserTunnelList,
  handleUserTunnelRemove,
  handleUserTunnelUpdate,
  probeAllTunnelsLatency,
  type TunnelRouteDeps,
} from "./routes/tunnel";
import {
  handleSetupInit,
  handleSetupStatus,
  handleUserCreate,
  handleUserDelete,
  handleUserList,
  handleUserLogin,
  handleUserPackage,
  handleUserReset,
  handleUserUpdate,
  handleUserUpdatePassword,
  type UserRouteDeps,
} from "./routes/user";
import { parseTzOffsetMinutes } from "./utils/timezone";
import {
  BizError,
  failCode,
  ok,
  paramInt,
  type R,
  ValidError,
} from "./utils/validation";

interface WsAttachment {
  isNode: boolean;
  id: number;
  secret: string;
  version: string;
}

interface PendingRequest {
  resolve: (r: AgentResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const NOT_FOUND_HTML =
  "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>错误 404</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;margin:0;min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}.c{font-size:6rem;color:#333;font-weight:300;margin:0}.t{font-size:1.2rem;color:#666;margin-top:20px}</style></head><body><div class='c'>404</div><div class='t'>你推开了后端的大门，却发现里面只有寂寞。</div></body></html>";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Authorization",
    "Access-Control-Max-Age": "3600",
  };
}

function jsonResp(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function textResp(body: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

export class PanelHub extends DurableObject<Env> implements AgentMessenger {
  private readonly db: PanelDB;
  private readonly tzOffsetMin: number;
  private readonly panelVersion: string;
  private readonly releaseRepo: string;
  private jwtSecretCache: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly upgradeStates = new Map<number, NodeUpgradeState>();
  private readonly releaseCache: ReleaseCache = { value: null, fetchedAt: 0 };
  private lockTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PanelDB(ctx.storage.sql);
    this.tzOffsetMin = parseTzOffsetMinutes(env.TZ_OFFSET_MINUTES);
    this.panelVersion = env.PANEL_VERSION || "1.06-cf";
    this.releaseRepo = env.RELEASE_REPO || "qqlikegi/forwardz";

    // Free Plan 核心优化：平台层零计费自动响应 ping -> pong，不唤醒 DO
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    ctx.blockConcurrencyWhile(async () => {
      initDatabase(ctx.storage.sql);
      // 同步数据库中的在线状态与当前存活的休眠 WebSocket，清理僵尸在线状态
      const liveNodeIds = new Set<number>();
      for (const ws of ctx.getWebSockets("node")) {
        const att = ws.deserializeAttachment() as WsAttachment | null;
        if (att?.isNode) liveNodeIds.add(att.id);
      }
      for (const n of this.db.listNodes("WHERE status = 1")) {
        if (!liveNodeIds.has(n.id)) {
          this.db.sql.exec("UPDATE node SET status = 0 WHERE id = ?", n.id);
        }
      }
      await this.scheduleNextBackupAlarm();
    });
  }

  private getJwtSecret(): string {
    if (this.jwtSecretCache) return this.jwtSecretCache;
    const fromEnv = (this.env.JWT_SECRET ?? "").trim();
    if (fromEnv.length >= 16) {
      this.jwtSecretCache = fromEnv;
      return fromEnv;
    }
    const stored = this.db.getSetting("jwt_secret").trim();
    if (stored.length >= 16) {
      this.jwtSecretCache = stored;
      return stored;
    }
    const created = newRandomHex(32);
    this.db.setSetting("jwt_secret", created);
    this.jwtSecretCache = created;
    return created;
  }

  /** 串行化涉及端口规划/配置同步的写操作（不阻塞普通查询或 WS 回包） */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  // ---------- AgentMessenger 实现（基于 WebSocket Hibernation） ----------

  private getNodeSocket(nodeId: number): { ws: WebSocket; att: WsAttachment } | null {
    const sockets = this.ctx.getWebSockets(`node:${nodeId}`);
    for (let i = sockets.length - 1; i >= 0; i--) {
      const ws = sockets[i];
      if (ws.readyState === WebSocket.OPEN) {
        const att = ws.deserializeAttachment() as WsAttachment | null;
        if (att) return { ws, att };
      }
    }
    return null;
  }

  nodeOnline(nodeId: number): boolean {
    return this.getNodeSocket(nodeId) !== null;
  }

  private sendRawToNode(ws: WebSocket, secret: string, payload: string): void {
    const out = encryptForNode(secret, payload);
    ws.send(out);
  }

  private broadcastToAdmins(v: unknown): void {
    const msg = JSON.stringify(v);
    for (const ws of this.ctx.getWebSockets("admin")) {
      try {
        ws.send(msg);
      } catch {
        // 忽略已失效连接
      }
    }
  }

  /** 构造带流量上报策略的 SetReportInterval 载荷（向后兼容 v1.03） */
  private buildReportIntervalPayload(intervalSec: number, policy?: FlowReportPolicy): string {
    const p = policy ?? loadFlowReportPolicy(this.db);
    return JSON.stringify({
      type: "SetReportInterval",
      data: {
        intervalSec,
        flowIntervalSec: p.flowIntervalSec,
        flowThresholdBytes: p.flowThresholdBytes,
        flowMinBytes: p.flowMinBytes,
      },
    });
  }

  /** 按当前是否有管理员打开节点页，动态切换节点端系统信息上报频率 */
  private notifyTelemetryMode(intervalSec: number, targetNodeId?: number): void {
    const payload = this.buildReportIntervalPayload(intervalSec);
    const sockets =
      targetNodeId !== undefined
        ? this.ctx.getWebSockets(`node:${targetNodeId}`)
        : this.ctx.getWebSockets("node");
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att?.isNode) continue;
      try {
        this.sendRawToNode(ws, att.secret, payload);
      } catch {
        // 忽略发送失败
      }
    }
  }

  /** 将最新流量上报策略立即推送到所有在线节点 */
  private pushFlowPolicyToOnlineNodes(policy: FlowReportPolicy): number {
    const hasAdmin = this.ctx.getWebSockets("admin").length > 0;
    const payload = this.buildReportIntervalPayload(hasAdmin ? 2 : 0, policy);
    let pushed = 0;
    for (const ws of this.ctx.getWebSockets("node")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att?.isNode) continue;
      try {
        this.sendRawToNode(ws, att.secret, payload);
        pushed++;
      } catch {
        // 忽略发送失败
      }
    }
    return pushed;
  }

  async sendMsg(nodeId: number, data: unknown, typ: string): Promise<AgentResult> {
    const found = this.getNodeSocket(nodeId);
    if (!found) {
      return { msg: "节点不在线" };
    }
    const requestId = newUUID();
    const payload = JSON.stringify({ type: typ, data, requestId });

    return new Promise<AgentResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ msg: "等待响应超时" });
      }, 10_000);

      this.pending.set(requestId, { resolve, timer });
      try {
        this.sendRawToNode(found.ws, found.att.secret, payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ msg: `发送消息失败: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  // ---------- 依赖组装 ----------

  private forwardDeps(): ForwardRouteDeps {
    return {
      db: this.db,
      messenger: this,
      withLock: (fn) => this.withLock(fn),
    };
  }

  private tunnelDeps(): TunnelRouteDeps {
    const fDeps = this.forwardDeps();
    return {
      db: this.db,
      messenger: this,
      withLock: (fn) => this.withLock(fn),
      deleteForwardInternal: (f) => deleteForwardInternal(fDeps, f),
      syncForward: (f, inPort) => syncForward(fDeps, f, inPort),
    };
  }

  private nodeDeps(): NodeRouteDeps {
    const tDeps = this.tunnelDeps();
    return {
      db: this.db,
      messenger: this,
      releaseRepo: this.releaseRepo,
      withLock: (fn) => this.withLock(fn),
      deleteTunnelInternal: (tid) => deleteTunnelInternal(tDeps, tid),
    };
  }

  private nodeUpgradeDeps(): NodeUpgradeDeps {
    return {
      db: this.db,
      messenger: this,
      releaseRepo: this.releaseRepo,
      releaseCache: this.releaseCache,
      upgradeStates: this.upgradeStates,
    };
  }

  private userDeps(): UserRouteDeps {
    const fDeps = this.forwardDeps();
    return {
      db: this.db,
      jwtSecret: this.getJwtSecret(),
      tzOffsetMin: this.tzOffsetMin,
      deleteForwardInternal: (f) => deleteForwardInternal(fDeps, f),
    };
  }

  private backupHost(): BackupHost {
    return {
      db: this.db,
      version: this.panelVersion,
      tzOffsetMin: this.tzOffsetMin,
      scheduleNextAlarm: () => this.scheduleNextBackupAlarm(),
    };
  }

  // ---------- Cron RPC & Backup Alarm ----------

  async runHourlyStats(): Promise<void> {
    runStatisticsFlow(this.db, this.tzOffsetMin);
  }

  async runDailyReset(force = false): Promise<boolean> {
    return runResetFlowTask(this.db, this, this.tzOffsetMin, force);
  }

  async runTunnelLatencyProbe(): Promise<number> {
    return probeAllTunnelsLatency(this.db, this);
  }

  private async scheduleNextBackupAlarm(): Promise<void> {
    const cfg = loadBackupConfig(this.db);
    if (!cfg.enabled) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    let anchor = parseInt(this.db.getSetting("backup_anchor"), 10) || 0;
    if (anchor <= 0) {
      anchor = Date.now();
      this.db.setSetting("backup_anchor", String(anchor));
    }
    const nextMs = Math.max(Date.now() + 5_000, nextBackupRunMs(cfg, anchor, this.tzOffsetMin));
    await this.ctx.storage.setAlarm(nextMs);
  }

  override async alarm(): Promise<void> {
    const cfg = loadBackupConfig(this.db);
    if (!cfg.enabled) return;
    this.db.setSetting("backup_anchor", String(Date.now()));
    await runBackupNow(this.backupHost());
    await this.scheduleNextBackupAlarm();
  }

  // ---------- WebSocket 入口与 Hibernation 事件 ----------

  private handleWebSocketUpgrade(request: Request, url: URL): Response {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return textResp("Expected WebSocket upgrade", 426);
    }
    const q = url.searchParams;
    const secret = q.get("secret") ?? "";
    const isNode = q.get("type") === "1";

    let att: WsAttachment;
    if (isNode) {
      const node = this.db.getNodeBySecret(secret);
      if (!node || !secret) {
        return textResp("forbidden", 403);
      }
      att = {
        isNode: true,
        id: node.id,
        secret,
        version: q.get("version") ?? "",
      };
    } else {
      const claims = parseToken(secret, this.getJwtSecret());
      if (!claims) {
        return textResp("forbidden", 403);
      }
      att = {
        isNode: false,
        id: claims.userId,
        secret: "",
        version: "",
      };
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (att.isNode) {
      // 关闭同节点旧连接
      for (const old of this.ctx.getWebSockets(`node:${att.id}`)) {
        try {
          old.close(1000, "replaced by new connection");
        } catch {
          // 忽略
        }
      }
      this.ctx.acceptWebSocket(server, ["node", `node:${att.id}`]);
      server.serializeAttachment(att);

      const sets = ["status = 1"];
      const args: unknown[] = [];
      if (att.version) {
        sets.push("version = ?");
        args.push(att.version);
      }
      for (const col of ["http", "tls", "socks"] as const) {
        const raw = q.get(col);
        if (raw !== null && /^\d+$/.test(raw)) {
          sets.push(`${col} = ?`);
          args.push(parseInt(raw, 10));
        }
      }
      args.push(att.id);
      this.db.sql.exec(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...args);
      this.broadcastToAdmins({ id: String(att.id), type: "status", data: 1 });

      // 若该节点处于远程升级中，重新连上线即标记为升级完成
      const prevUp = this.upgradeStates.get(att.id);
      if (
        prevUp &&
        (prevUp.status === "started" ||
          prevUp.status === "downloading" ||
          prevUp.status === "verifying" ||
          prevUp.status === "restarting")
      ) {
        const newVer = normalizeVersion(att.version) || prevUp.toVersion || "";
        this.upgradeStates.set(att.id, {
          status: "success",
          fromVersion: prevUp.fromVersion,
          toVersion: newVer,
          message: newVer ? `已升级至 ${newVer} 并重新上线` : "已重启并重新上线",
          updatedAt: Date.now(),
        });
      }

      // 若当前已有管理员打开节点监控页，立即开启 2 秒实时推送；否则保持 0 计费节能心跳，并同步最新流量上报策略
      const hasAdmin = this.ctx.getWebSockets("admin").length > 0;
      try {
        this.sendRawToNode(server, att.secret, this.buildReportIntervalPayload(hasAdmin ? 2 : 0));
      } catch {
        // 忽略
      }
    } else {
      const prevAdmins = this.ctx.getWebSockets("admin").length;
      this.ctx.acceptWebSocket(server, ["admin", `user:${att.id}`]);
      server.serializeAttachment(att);
      if (prevAdmins === 0) {
        this.notifyTelemetryMode(2);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const rawText =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(new Uint8Array(message));
    if (!rawText.trim()) return;

    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att || !att.isNode) return;

    const payload = decryptIfNeeded(rawText, att.secret);

    // 1. 节点经 WebSocket 上报流量 / 配置 / 升级进度
    if (
      payload.includes('"FlowReport"') ||
      payload.includes('"ConfigReport"') ||
      payload.includes('"UpgradeStatus"')
    ) {
      try {
        const envMsg = JSON.parse(payload) as {
          type?: string;
          data?: unknown;
          requestId?: string;
        };
        if (envMsg.type === "UpgradeStatus" && envMsg.data && typeof envMsg.data === "object") {
          const d = envMsg.data as {
            status?: string;
            fromVersion?: string;
            toVersion?: string;
            message?: string;
          };
          const allowed: UpgradeStatusKind[] = [
            "started",
            "downloading",
            "verifying",
            "restarting",
            "success",
            "up_to_date",
            "failed",
          ];
          const status: UpgradeStatusKind = allowed.includes(d.status as UpgradeStatusKind)
            ? (d.status as UpgradeStatusKind)
            : "downloading";
          this.upgradeStates.set(att.id, {
            status,
            fromVersion: d.fromVersion ? normalizeVersion(d.fromVersion) : undefined,
            toVersion: d.toVersion ? normalizeVersion(d.toVersion) : undefined,
            message: d.message || status,
            updatedAt: Date.now(),
          });
          return;
        }
        if (envMsg.type === "FlowReport" && Array.isArray(envMsg.data)) {
          await processFlowItems(this.db, this, envMsg.data as FlowItem[]);
          if (envMsg.requestId) {
            this.sendRawToNode(
              ws,
              att.secret,
              JSON.stringify({ type: "FlowReportAck", requestId: envMsg.requestId, message: "OK" }),
            );
          }
          return;
        }
        if (envMsg.type === "ConfigReport" && envMsg.data !== undefined) {
          const cfgStr = typeof envMsg.data === "string" ? envMsg.data : JSON.stringify(envMsg.data);
          await handleFlowConfig(
            this.db,
            this,
            att.secret,
            cfgStr,
            (fn) => this.withLock(fn),
            (p) => this.ctx.waitUntil(p),
          );
          return;
        }
      } catch {
        // 回退下方通用处理
      }
    }

    // 2. 节点系统监控信息（兼容旧版与按需实时推送）
    if (payload.includes("memory_usage")) {
      try {
        this.sendRawToNode(ws, att.secret, '{"type":"call"}');
      } catch {
        // 忽略
      }
    } else if (payload.includes("requestId")) {
      try {
        const resp = JSON.parse(payload) as {
          requestId?: string;
          message?: string | null;
          type?: string;
          data?: Record<string, unknown>;
        };
        if (resp.requestId) {
          const p = this.pending.get(resp.requestId);
          if (p) {
            this.pending.delete(resp.requestId);
            clearTimeout(p.timer);
            const msg =
              resp.message !== undefined && resp.message !== null
                ? resp.message
                : resp.type === "PingResponse"
                  ? "OK"
                  : "无响应消息";
            p.resolve({
              msg,
              data: resp.data && typeof resp.data === "object" ? resp.data : undefined,
            });
          }
        }
      } catch {
        // 忽略解析失败
      }
    }

    // 转发监控消息给当前在线的管理员页
    const admins = this.ctx.getWebSockets("admin");
    if (admins.length > 0) {
      const fwd = JSON.stringify({ id: String(att.id), type: "info", data: payload });
      for (const a of admins) {
        try {
          a.send(fwd);
        } catch {
          // 忽略
        }
      }
    }
  }

  private handleSocketClosed(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;
    if (!att.isNode) {
      // 若最后一个管理员已离开节点页，通知所有节点恢复零计费节能心跳
      const remaining = this.ctx
        .getWebSockets("admin")
        .filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
      if (remaining.length === 0) {
        this.notifyTelemetryMode(0);
      }
      return;
    }

    const others = this.ctx
      .getWebSockets(`node:${att.id}`)
      .filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length > 0) return; // 已被新连接替换，不置离线

    this.db.sql.exec("UPDATE node SET status = 0 WHERE id = ?", att.id);
    this.broadcastToAdmins({ id: String(att.id), type: "status", data: 0 });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleSocketClosed(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.handleSocketClosed(ws);
    try {
      ws.close(1011, "error");
    } catch {
      // 忽略
    }
  }

  // ---------- HTTP 路由总分发 ----------

  override async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    // 1. WebSocket 入口
    if (pathname === "/system-info") {
      return this.handleWebSocketUpgrade(request, url);
    }

    // 2. 节点 HTTP 上报（保持 100% 向后兼容）
    if (pathname === "/flow/test") {
      return textResp("test");
    }
    if (pathname === "/flow/upload") {
      const secret = url.searchParams.get("secret") ?? "";
      const body = await request.text();
      const res = await handleFlowUpload(this.db, this, secret, body);
      return textResp(res);
    }
    if (pathname === "/flow/config" && method === "POST") {
      const secret = url.searchParams.get("secret") ?? "";
      const body = await request.text();
      const res = await handleFlowConfig(
        this.db,
        this,
        secret,
        body,
        (fn) => this.withLock(fn),
        (p) => this.ctx.waitUntil(p),
      );
      return textResp(res);
    }

    // 3. 受保护的一次性 SQLite 迁移接口（仅配置 MIGRATION_TOKEN 时生效）
    if (pathname.startsWith("/api/v1/migrate/")) {
      const authErr = verifyMigrationToken(request, this.env.MIGRATION_TOKEN);
      if (authErr) return jsonResp(authErr);
      try {
        const raw = await request.text();
        const body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (pathname === "/api/v1/migrate/status") {
          return jsonResp(handleMigrateStatus(this.db));
        }
        if (pathname === "/api/v1/migrate/reset" && method === "POST") {
          return jsonResp(handleMigrateReset(this.db));
        }
        if (pathname === "/api/v1/migrate/batch" && method === "POST") {
          return jsonResp(handleMigrateBatch(this.db, body as { table?: string; rows?: Record<string, unknown>[] }));
        }
        if (pathname === "/api/v1/migrate/finalize" && method === "POST") {
          return jsonResp(
            handleMigrateFinalize(this.db, body as { sequences?: Record<string, number>; panelAddr?: string }),
          );
        }
      } catch (e) {
        return jsonResp(failCode(-2, e instanceof Error ? e.message : String(e)));
      }
      return new Response(NOT_FOUND_HTML, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=UTF-8", ...corsHeaders() },
      });
    }

    // 4. Sub-Store 订阅头接口
    if (pathname === "/api/v1/open_api/sub_store" && method === "GET") {
      const r = handleOpenSubStore(this.db, url);
      if (r.r) return jsonResp(r.r);
      return textResp(r.text ?? "", 200, r.header ? { "subscription-userinfo": r.header } : undefined);
    }

    // 5. 标准 /api/v1/* POST 接口
    if (method === "POST" && pathname.startsWith("/api/v1/")) {
      return this.dispatchApi(request, pathname);
    }

    return new Response(NOT_FOUND_HTML, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8", ...corsHeaders() },
    });
  }

  private async dispatchApi(request: Request, pathname: string): Promise<Response> {
    type Level = "public" | "user" | "admin";
    type Handler = (body: Record<string, unknown>, claims: Claims | null) => R | Promise<R>;

    const table: Record<string, { level: Level; fn: Handler }> = {
      // 首次初始化 & 验证码（私人站点默认关闭验证码）
      "/api/v1/setup/status": { level: "public", fn: () => handleSetupStatus(this.db) },
      "/api/v1/setup/init": { level: "public", fn: (b) => handleSetupInit(this.userDeps(), b) },
      "/api/v1/captcha/check": { level: "public", fn: () => ok(0) },

      // 用户
      "/api/v1/user/login": { level: "public", fn: (b) => handleUserLogin(this.userDeps(), b) },
      "/api/v1/user/create": { level: "admin", fn: (b) => handleUserCreate(this.db, b) },
      "/api/v1/user/list": { level: "admin", fn: () => handleUserList(this.db) },
      "/api/v1/user/update": { level: "admin", fn: (b) => handleUserUpdate(this.db, b) },
      "/api/v1/user/delete": { level: "admin", fn: (b) => handleUserDelete(this.userDeps(), b) },
      "/api/v1/user/package": { level: "user", fn: (_b, c) => handleUserPackage(this.userDeps(), c!) },
      "/api/v1/user/updatePassword": {
        level: "user",
        fn: (b, c) => handleUserUpdatePassword(this.db, c!, b),
      },
      "/api/v1/user/reset": { level: "admin", fn: (b) => handleUserReset(this.db, b) },

      // 节点
      "/api/v1/node/create": { level: "admin", fn: (b) => handleNodeCreate(this.db, b) },
      "/api/v1/node/list": { level: "admin", fn: () => handleNodeList(this.db) },
      "/api/v1/node/update": { level: "admin", fn: (b) => handleNodeUpdate(this.nodeDeps(), b) },
      "/api/v1/node/delete": { level: "admin", fn: (b) => handleNodeDelete(this.nodeDeps(), b) },
      "/api/v1/node/install": {
        level: "admin",
        fn: (b) => handleNodeInstall(this.nodeDeps(), b, request.url),
      },
      "/api/v1/node/flow-policy/get": {
        level: "admin",
        fn: () =>
          handleFlowPolicyGet(
            this.db,
            this.ctx.getWebSockets("node").filter((s) => s.readyState === WebSocket.OPEN).length,
          ),
      },
      "/api/v1/node/flow-policy/save": {
        level: "admin",
        fn: (b) =>
          handleFlowPolicySave(this.db, b, (policy) => this.pushFlowPolicyToOnlineNodes(policy)),
      },
      "/api/v1/node/upgrade-info": {
        level: "admin",
        fn: (b) => handleNodeUpgradeInfo(this.nodeUpgradeDeps(), b),
      },
      "/api/v1/node/upgrade-all": {
        level: "admin",
        fn: (b) => handleNodeUpgradeAll(this.nodeUpgradeDeps(), b),
      },

      // 隧道 & 用户隧道权限
      "/api/v1/tunnel/create": { level: "admin", fn: (b) => handleTunnelCreate(this.tunnelDeps(), b) },
      "/api/v1/tunnel/list": { level: "admin", fn: () => handleTunnelList(this.db) },
      "/api/v1/tunnel/update": { level: "admin", fn: (b) => handleTunnelUpdate(this.tunnelDeps(), b) },
      "/api/v1/tunnel/delete": { level: "admin", fn: (b) => handleTunnelDelete(this.tunnelDeps(), b) },
      "/api/v1/tunnel/user/assign": { level: "admin", fn: (b) => handleUserTunnelAssign(this.db, b) },
      "/api/v1/tunnel/user/list": { level: "admin", fn: (b) => handleUserTunnelList(this.db, b) },
      "/api/v1/tunnel/user/remove": {
        level: "admin",
        fn: (b) => handleUserTunnelRemove(this.tunnelDeps(), b),
      },
      "/api/v1/tunnel/user/update": {
        level: "admin",
        fn: (b) => handleUserTunnelUpdate(this.tunnelDeps(), b),
      },
      "/api/v1/tunnel/user/tunnel": { level: "user", fn: (_b, c) => handleTunnelForUser(this.db, c!) },
      "/api/v1/tunnel/diagnose": {
        level: "admin",
        fn: (b) => handleTunnelDiagnose(this.tunnelDeps(), b),
      },
      "/api/v1/tunnel/latency-history": {
        level: "admin",
        fn: (b) => handleTunnelLatencyHistory(this.db, b),
      },
      "/api/v1/tunnel/probe-now": {
        level: "admin",
        fn: (b) => handleTunnelProbeNow(this.db, this, b),
      },

      // 转发
      "/api/v1/forward/create": {
        level: "user",
        fn: (b, c) => handleForwardCreate(this.forwardDeps(), c!, b),
      },
      "/api/v1/forward/list": { level: "user", fn: (_b, c) => handleForwardList(this.db, c!) },
      "/api/v1/forward/update": {
        level: "user",
        fn: (b, c) => handleForwardUpdate(this.forwardDeps(), c!, b),
      },
      "/api/v1/forward/delete": {
        level: "user",
        fn: (b, c) => handleForwardDelete(this.forwardDeps(), c!, b),
      },
      "/api/v1/forward/force-delete": {
        level: "user",
        fn: (b, c) => handleForwardForceDelete(this.db, c!, b),
      },
      "/api/v1/forward/pause": {
        level: "user",
        fn: (b, c) => changeForwardStatus(this.forwardDeps(), c!, paramInt(b, "id"), 0, "PauseService"),
      },
      "/api/v1/forward/resume": {
        level: "user",
        fn: (b, c) =>
          changeForwardStatus(this.forwardDeps(), c!, paramInt(b, "id"), 1, "ResumeService"),
      },
      "/api/v1/forward/diagnose": {
        level: "user",
        fn: (b, c) => handleForwardDiagnose(this.forwardDeps(), c!, b),
      },
      "/api/v1/forward/update-order": {
        level: "user",
        fn: (b, c) => handleForwardUpdateOrder(this.db, c!, b),
      },

      // 限速
      "/api/v1/speed-limit/create": {
        level: "admin",
        fn: (b) => handleSpeedCreate(this.forwardDeps(), b),
      },
      "/api/v1/speed-limit/list": { level: "admin", fn: () => handleSpeedList(this.db) },
      "/api/v1/speed-limit/update": {
        level: "admin",
        fn: (b) => handleSpeedUpdate(this.forwardDeps(), b),
      },
      "/api/v1/speed-limit/delete": {
        level: "admin",
        fn: (b) => handleSpeedDelete(this.forwardDeps(), b),
      },
      "/api/v1/speed-limit/tunnels": { level: "admin", fn: () => handleTunnelList(this.db) },

      // 数据总览
      "/api/v1/dashboard/overview": {
        level: "admin",
        fn: () => handleDashboardOverview(this.db, this.tzOffsetMin),
      },

      // 云存储备份 & 指纹
      "/api/v1/backup/get": { level: "admin", fn: () => handleBackupGet(this.backupHost()) },
      "/api/v1/backup/save": { level: "admin", fn: (b) => handleBackupSave(this.backupHost(), b) },
      "/api/v1/backup/test": { level: "admin", fn: (b) => handleBackupTest(this.backupHost(), b) },
      "/api/v1/backup/run": { level: "admin", fn: () => handleBackupRun(this.backupHost()) },
      "/api/v1/backup/list": { level: "admin", fn: () => handleBackupList(this.backupHost()) },
      "/api/v1/fingerprint/get": { level: "admin", fn: () => handleFingerprintGet(this.db) },
      "/api/v1/fingerprint/save": { level: "admin", fn: (b) => handleFingerprintSave(this.db, b) },

      // 系统配置
      "/api/v1/config/list": { level: "user", fn: () => handleConfigList(this.db) },
      "/api/v1/config/get": { level: "public", fn: (b) => handleConfigGet(this.db, b) },
      "/api/v1/config/update": { level: "admin", fn: (b) => handleConfigUpdate(this.db, b) },
      "/api/v1/config/update-single": {
        level: "admin",
        fn: (b) => handleConfigUpdateSingle(this.db, b),
      },
    };

    const route = table[pathname];
    if (!route) {
      return new Response(NOT_FOUND_HTML, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=UTF-8", ...corsHeaders() },
      });
    }

    let claims: Claims | null = null;
    const token = (request.headers.get("Authorization") ?? "").trim();
    if (route.level !== "public") {
      if (!token) return jsonResp(failCode(401, "未登录或token已过期"));
      claims = parseToken(token, this.getJwtSecret());
      if (!claims) return jsonResp(failCode(401, "无效的token或token已过期"));
      if (route.level === "admin" && claims.roleId !== 0) {
        return jsonResp(failCode(403, "权限不足，仅管理员可操作"));
      }
    } else if (token) {
      claims = parseToken(token, this.getJwtSecret());
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await request.text();
      if (raw.trim() !== "") {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        } else {
          return jsonResp(failCode(-2, "请求参数格式错误"));
        }
      }
    } catch (e) {
      return jsonResp(
        failCode(-2, `请求参数格式错误: ${e instanceof Error ? e.message : String(e)}`),
      );
    }

    try {
      const result = await route.fn(body, claims);
      return jsonResp(result);
    } catch (e) {
      if (e instanceof BizError) {
        return jsonResp(failCode(-2, e.message));
      }
      if (e instanceof ValidError) {
        return jsonResp(failCode(500, e.message));
      }
      console.error(
        JSON.stringify({
          event: "api_error",
          path: pathname,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return jsonResp(failCode(-2, e instanceof Error ? e.message : String(e)));
    }
  }
}
