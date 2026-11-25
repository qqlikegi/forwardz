import { agentPauseResume, type AgentMessenger } from "../agent/commands";
import { applyDiff, desiredStates, stateFromReport } from "../agent/reconcile";
import { decryptIfNeeded } from "../crypto";
import { type ForwardRow, type PanelDB, serviceName } from "../db/queries";
import {
  formatLocalDate,
  formatLocalHour,
  formatLocalMonth,
  localCalendarParts,
  localDayStartMs,
} from "../utils/timezone";
import { BYTES_PER_GB, numInt, ok, parseNum, type R } from "../utils/validation";

export interface FlowItem {
  n: string;
  u: unknown;
  d: unknown;
}

export async function pauseForwards(
  db: PanelDB,
  messenger: AgentMessenger,
  list: ForwardRow[],
): Promise<void> {
  for (const f of list) {
    const name = serviceName(f.id, f.userId, db.getUserTunnel(f.userId, f.tunnelId));
    for (const ct of db.entryChains(f.tunnelId)) {
      await agentPauseResume(messenger, ct.nodeId, name, "PauseService");
    }
    db.sql.exec("UPDATE forward SET status = 0 WHERE id = ?", f.id);
  }
}

/**
 * 批量处理流量上报：先在内存中按 forward / user / user_tunnel 合并，再最小化 SQLite 写行数，
 * 避免 Workers Free Plan 触及每日 10 万写行上限。
 */
export async function processFlowItems(
  db: PanelDB,
  messenger: AgentMessenger,
  items: FlowItem[],
): Promise<void> {
  const fwdDeltas = new Map<number, { down: number; up: number }>();
  const userDeltas = new Map<number, { down: number; up: number }>();
  const utDeltas = new Map<number, { down: number; up: number }>();
  const checkUsers = new Set<number>();
  const checkUTs = new Map<number, number>(); // userTunnelId -> userId

  for (const it of items) {
    if (!it || typeof it.n !== "string" || it.n === "web_api") continue;
    const parts = it.n.split("_");
    if (parts.length < 3) continue;
    const forwardId = parseInt(parts[0], 10);
    const userId = parseInt(parts[1], 10);
    const userTunnelId = parseInt(parts[2], 10);
    if (Number.isNaN(forwardId) || Number.isNaN(userId) || Number.isNaN(userTunnelId)) continue;

    let up = 0;
    let down = 0;
    try {
      up = numInt(parseNum(it.u));
      down = numInt(parseNum(it.d));
    } catch {
      continue;
    }
    if (up === 0 && down === 0) continue;

    const f = db.getForward(forwardId);
    if (f) {
      const t = db.getTunnel(f.tunnelId);
      if (t) {
        down = Math.trunc(down * t.trafficRatio) * t.flow;
        up = Math.trunc(up * t.trafficRatio) * t.flow;
      }
    }

    const add = (m: Map<number, { down: number; up: number }>, key: number) => {
      const cur = m.get(key);
      if (cur) {
        cur.down += down;
        cur.up += up;
      } else {
        m.set(key, { down, up });
      }
    };
    add(fwdDeltas, forwardId);
    add(userDeltas, userId);
    if (userTunnelId !== 0) {
      add(utDeltas, userTunnelId);
      checkUsers.add(userId);
      checkUTs.set(userTunnelId, userId);
    }
  }

  for (const [fid, d] of fwdDeltas.entries()) {
    db.sql.exec(
      "UPDATE forward SET in_flow = in_flow + ?, out_flow = out_flow + ? WHERE id = ?",
      d.down,
      d.up,
      fid,
    );
  }
  for (const [uid, d] of userDeltas.entries()) {
    db.sql.exec(
      "UPDATE user SET in_flow = in_flow + ?, out_flow = out_flow + ? WHERE id = ?",
      d.down,
      d.up,
      uid,
    );
  }
  for (const [utid, d] of utDeltas.entries()) {
    db.sql.exec(
      "UPDATE user_tunnel SET in_flow = in_flow + ?, out_flow = out_flow + ? WHERE id = ?",
      d.down,
      d.up,
      utid,
    );
  }

  const now = Date.now();
  for (const uid of checkUsers) {
    const u = db.getUser(uid);
    if (!u) continue;
    if (u.flow * BYTES_PER_GB < u.inFlow + u.outFlow || u.expTime <= now || u.status !== 1) {
      await pauseForwards(db, messenger, db.listForwards("WHERE user_id = ? AND status = 1", uid));
    }
  }
  for (const [utid, uid] of checkUTs.entries()) {
    const ut = db.getUserTunnelById(utid);
    if (!ut) continue;
    if (ut.inFlow + ut.outFlow >= ut.flow * BYTES_PER_GB || ut.expTime <= now || ut.status !== 1) {
      await pauseForwards(
        db,
        messenger,
        db.listForwards("WHERE tunnel_id = ? AND user_id = ? AND status = 1", ut.tunnelId, uid),
      );
    }
  }
}

export async function handleFlowUpload(
  db: PanelDB,
  messenger: AgentMessenger,
  secret: string,
  rawBody: string,
): Promise<string> {
  if (!db.getNodeBySecret(secret)) return "ok";
  const plain = decryptIfNeeded(rawBody, secret);
  try {
    const items = JSON.parse(plain) as FlowItem[];
    if (Array.isArray(items)) {
      await processFlowItems(db, messenger, items);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_upload_parse_error", error: String(e) }));
  }
  return "ok";
}

export async function handleFlowConfig(
  db: PanelDB,
  messenger: AgentMessenger,
  secret: string,
  rawBody: string,
  withLock: <T>(fn: () => Promise<T>) => Promise<T>,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<string> {
  const node = db.getNodeBySecret(secret);
  if (!node) return "ok";
  const plain = decryptIfNeeded(rawBody, secret);
  let actual;
  try {
    actual = stateFromReport(plain);
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_config_parse_error", nodeId: node.id, error: String(e) }));
    return "ok";
  }

  const task = withLock(async () => {
    const want = desiredStates(db, [node.id]).get(node.id);
    if (!want) return;
    const errs = await applyDiff(messenger, node.id, actual, want);
    if (errs.length > 0) {
      console.error(JSON.stringify({ event: "reconcile_failed", nodeId: node.id, errs }));
    }
  });

  if (waitUntil) {
    waitUntil(task);
  } else {
    await task;
  }
  return "ok";
}

// ---------- 定时任务：整点统计 & 每日重置/到期 ----------

export function runStatisticsFlow(db: PanelDB, tzOffsetMin: number): void {
  const nowMs = Date.now();
  const hour = formatLocalHour(nowMs, tzOffsetMin);
  // 整点统计的是上一个小时的流量，计入上一小时所在的日期
  const day = formatLocalDate(nowMs - 60_000, tzOffsetMin);
  db.sql.exec("DELETE FROM statistics_flow WHERE created_time < ?", nowMs - 48 * 3600_000);

  const users = db.listUsers();
  for (const u of users) {
    const total = u.inFlow + u.outFlow;
    let inc = total;
    const prev = db.sql
      .exec<{ total_flow: number }>(
        "SELECT total_flow FROM statistics_flow WHERE user_id = ? ORDER BY id DESC LIMIT 1",
        u.id,
      )
      .toArray()[0];
    if (prev) {
      inc = total - Number(prev.total_flow);
      if (inc < 0) inc = total;
    }
    db.sql.exec(
      "INSERT INTO statistics_flow (user_id, flow, total_flow, time, created_time) VALUES (?, ?, ?, ?, ?)",
      u.id,
      inc,
      total,
      hour,
      nowMs,
    );
    if (inc > 0) {
      db.sql.exec(
        `INSERT INTO user_flow_daily (user_id, day, flow) VALUES (?, ?, ?)
         ON CONFLICT(user_id, day) DO UPDATE SET flow = flow + excluded.flow`,
        u.id,
        day,
        inc,
      );
    }
  }
  const cutoffDay = formatLocalDate(nowMs - 400 * 86_400_000, tzOffsetMin);
  db.sql.exec("DELETE FROM user_flow_daily WHERE day < ?", cutoffDay);
}

export async function runResetFlowTask(
  db: PanelDB,
  messenger: AgentMessenger,
  tzOffsetMin: number,
  force = false,
): Promise<boolean> {
  const nowMs = Date.now();
  const cal = localCalendarParts(nowMs, tzOffsetMin);
  const today = formatLocalDate(nowMs, tzOffsetMin);
  if (!force) {
    // 仅在目标时区 00:xx 且今天尚未执行过时运行
    if (cal.hour !== 0) return false;
    if (db.getSetting("last_reset_flow_day") === today) return false;
  }
  db.setSetting("last_reset_flow_day", today);

  if (cal.day === cal.lastDay) {
    db.sql.exec(
      "UPDATE user SET in_flow = 0, out_flow = 0 WHERE flow_reset_time != 0 AND (flow_reset_time = ? OR flow_reset_time > ?)",
      cal.day,
      cal.lastDay,
    );
    db.sql.exec(
      "UPDATE user_tunnel SET in_flow = 0, out_flow = 0 WHERE flow_reset_time != 0 AND (flow_reset_time = ? OR flow_reset_time > ?)",
      cal.day,
      cal.lastDay,
    );
  } else {
    db.sql.exec(
      "UPDATE user SET in_flow = 0, out_flow = 0 WHERE flow_reset_time != 0 AND flow_reset_time = ?",
      cal.day,
    );
    db.sql.exec(
      "UPDATE user_tunnel SET in_flow = 0, out_flow = 0 WHERE flow_reset_time != 0 AND flow_reset_time = ?",
      cal.day,
    );
  }

  const expiredUsers = db.listUsers(
    "WHERE role_id != 0 AND status = 1 AND exp_time < ?",
    nowMs,
  );
  for (const u of expiredUsers) {
    await pauseForwards(db, messenger, db.listForwards("WHERE user_id = ? AND status = 1", u.id));
    db.sql.exec("UPDATE user SET status = 0 WHERE id = ?", u.id);
  }

  const expiredUTs = db.listUserTunnels("WHERE status = 1 AND exp_time < ?", nowMs);
  for (const ut of expiredUTs) {
    await pauseForwards(
      db,
      messenger,
      db.listForwards("WHERE tunnel_id = ? AND user_id = ? AND status = 1", ut.tunnelId, ut.userId),
    );
    db.sql.exec("UPDATE user_tunnel SET status = 0 WHERE id = ?", ut.id);
  }
  return true;
}

// ---------- 管理员首页数据总览 ----------

export function handleDashboardOverview(db: PanelDB, tzOffsetMin: number): R {
  const nowMs = Date.now();
  const today = formatLocalDate(nowMs, tzOffsetMin);
  const month = formatLocalMonth(nowMs, tzOffsetMin);

  const nodeStats = db.sql
    .exec<{ total: number; online: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END), 0) AS online FROM node",
    )
    .one();

  const todayMap = new Map<number, number>();
  const dayStart = localDayStartMs(nowMs, tzOffsetMin);
  for (const r of db.sql
    .exec<{ user_id: number; s: number }>(
      "SELECT user_id, COALESCE(SUM(flow), 0) AS s FROM statistics_flow WHERE created_time >= ? GROUP BY user_id",
      dayStart + 60_000,
    )
    .toArray()) {
    todayMap.set(Number(r.user_id), Number(r.s));
  }

  const monthMap = new Map<number, number>();
  for (const r of db.sql
    .exec<{ user_id: number; s: number }>(
      "SELECT user_id, COALESCE(SUM(flow), 0) AS s FROM user_flow_daily WHERE day >= ? AND day < ? GROUP BY user_id",
      `${month}-01`,
      today,
    )
    .toArray()) {
    monthMap.set(Number(r.user_id), Number(r.s));
  }
  for (const [uid, t] of todayMap.entries()) {
    monthMap.set(uid, (monthMap.get(uid) ?? 0) + t);
  }

  const lastTotal = new Map<number, number>();
  for (const r of db.sql
    .exec<{ user_id: number; total_flow: number }>(
      "SELECT user_id, total_flow FROM statistics_flow WHERE id IN (SELECT MAX(id) FROM statistics_flow GROUP BY user_id)",
    )
    .toArray()) {
    lastTotal.set(Number(r.user_id), Number(r.total_flow));
  }

  const forwardCount = new Map<number, number>();
  for (const r of db.sql
    .exec<{ user_id: number; c: number }>("SELECT user_id, COUNT(*) AS c FROM forward GROUP BY user_id")
    .toArray()) {
    forwardCount.set(Number(r.user_id), Number(r.c));
  }

  let totalUsed = 0;
  let totalToday = 0;
  let totalMonth = 0;
  const list: Record<string, unknown>[] = [];
  for (const u of db.listUsers("ORDER BY id")) {
    const used = u.inFlow + u.outFlow;
    let pending = 0;
    const last = lastTotal.get(u.id);
    if (last !== undefined) {
      pending = used - last;
      if (pending < 0) pending = used;
    }
    const t = (todayMap.get(u.id) ?? 0) + pending;
    const m = (monthMap.get(u.id) ?? 0) + pending;
    totalUsed += used;
    totalToday += t;
    totalMonth += m;
    if (u.roleId === 0) continue;
    list.push({
      id: u.id,
      user: u.user,
      status: u.status,
      flow: u.flow,
      num: u.num,
      usedFlow: used,
      todayFlow: t,
      monthFlow: m,
      expTime: u.expTime,
      forwardCount: forwardCount.get(u.id) ?? 0,
      flowResetTime: u.flowResetTime,
    });
  }

  const flows = db.sql
    .exec<{ time: string; s: number }>(
      "SELECT time, SUM(flow) AS s FROM statistics_flow WHERE created_time > ? GROUP BY time",
      nowMs - 24 * 3600_000,
    )
    .toArray()
    .map((r) => ({ time: r.time, flow: Number(r.s) }));

  return ok({
    nodeTotal: Number(nodeStats.total),
    nodeOnline: Number(nodeStats.online),
    totalUsedFlow: totalUsed,
    todayFlow: totalToday,
    monthFlow: totalMonth,
    userCount: list.length,
    users: list,
    statisticsFlows: flows,
  });
}
