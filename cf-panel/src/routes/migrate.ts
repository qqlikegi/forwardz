import { timingSafeEqualStr } from "../crypto";
import type { PanelDB } from "../db/queries";
import { FINGERPRINT_KEY, FINGERPRINT_RE, SETUP_DONE_KEY } from "../db/schema";
import { fail, failCode, ok, type R } from "../utils/validation";

/** 允许迁移导入的白名单表及列定义（与 schema.sql 完全一致） */
export const ALLOWED_TABLES: Record<string, readonly string[]> = {
  user: [
    "id",
    "user",
    "pwd",
    "role_id",
    "exp_time",
    "flow",
    "in_flow",
    "out_flow",
    "flow_reset_time",
    "num",
    "created_time",
    "updated_time",
    "status",
  ],
  node: [
    "id",
    "name",
    "secret",
    "server_ip",
    "port",
    "interface_name",
    "version",
    "http",
    "tls",
    "socks",
    "created_time",
    "updated_time",
    "status",
    "tcp_listen_addr",
    "udp_listen_addr",
  ],
  tunnel: [
    "id",
    "name",
    "traffic_ratio",
    "type",
    "protocol",
    "flow",
    "created_time",
    "updated_time",
    "status",
    "in_ip",
  ],
  chain_tunnel: [
    "id",
    "tunnel_id",
    "chain_type",
    "node_id",
    "port",
    "strategy",
    "inx",
    "protocol",
  ],
  forward: [
    "id",
    "user_id",
    "user_name",
    "name",
    "tunnel_id",
    "remote_addr",
    "strategy",
    "in_flow",
    "out_flow",
    "created_time",
    "updated_time",
    "status",
    "inx",
  ],
  forward_port: ["id", "forward_id", "node_id", "port"],
  speed_limit: [
    "id",
    "name",
    "speed",
    "tunnel_id",
    "tunnel_name",
    "created_time",
    "updated_time",
    "status",
  ],
  user_tunnel: [
    "id",
    "user_id",
    "tunnel_id",
    "speed_id",
    "num",
    "flow",
    "in_flow",
    "out_flow",
    "flow_reset_time",
    "exp_time",
    "status",
  ],
  vite_config: ["id", "name", "value", "time"],
  statistics_flow: ["id", "user_id", "flow", "total_flow", "time", "created_time"],
  user_flow_daily: ["user_id", "day", "flow"],
  system_setting: ["name", "value"],
};

export function verifyMigrationToken(req: Request, expectedToken?: string): R | null {
  if (!expectedToken || expectedToken.trim().length < 8) {
    return failCode(403, "未配置 MIGRATION_TOKEN，迁移接口已关闭");
  }
  const provided = req.headers.get("X-Migration-Token") ?? "";
  if (!provided || !timingSafeEqualStr(provided, expectedToken.trim())) {
    return failCode(401, "迁移令牌无效");
  }
  return null;
}

export function handleMigrateStatus(db: PanelDB): R {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(ALLOWED_TABLES)) {
    counts[table] = db.countOf(`SELECT COUNT(*) FROM "${table}"`);
  }
  return ok({ counts, fingerprint: db.getSetting(FINGERPRINT_KEY) });
}

export function handleMigrateReset(db: PanelDB): R {
  for (const table of Object.keys(ALLOWED_TABLES)) {
    db.sql.exec(`DELETE FROM "${table}"`);
  }
  try {
    db.sql.exec("DELETE FROM sqlite_sequence");
  } catch {
    // sqlite_sequence 可能尚未创建
  }
  return ok({ cleared: Object.keys(ALLOWED_TABLES) });
}

export function handleMigrateBatch(
  db: PanelDB,
  body: { table?: string; rows?: Record<string, unknown>[] },
): R {
  const table = body.table ?? "";
  const allowedCols = ALLOWED_TABLES[table];
  if (!allowedCols) {
    return fail(`不支持的表名: ${table}`);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return ok({ table, inserted: 0 });
  if (rows.length > 200) {
    return fail("单批最多导入 200 行，请拆分批次以避免超出 Free Plan CPU 限制");
  }

  let inserted = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const col of allowedCols) {
      if (Object.prototype.hasOwnProperty.call(row, col)) {
        cols.push(col);
        // 导入节点时统一重置为离线状态，等待节点连入新 CF 面板后自动上线
        if (table === "node" && col === "status") {
          vals.push(0);
        } else if (table === "chain_tunnel" && col === "chain_type") {
          vals.push(String(Math.trunc(Number(row[col]))));
        } else {
          vals.push(row[col] === undefined ? null : row[col]);
        }
      }
    }
    if (cols.length === 0) continue;
    const placeholders = cols.map(() => "?").join(", ");
    const colList = cols.map((c) => `"${c}"`).join(", ");
    db.sql.exec(`INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`, ...vals);
    inserted++;
  }
  return ok({ table, inserted });
}

export function handleMigrateFinalize(
  db: PanelDB,
  body: { sequences?: Record<string, number>; panelAddr?: string },
): R {
  // 校准自增序列，避免新写入的主键与迁移数据冲突
  const seqTables = [
    "user",
    "node",
    "tunnel",
    "chain_tunnel",
    "forward",
    "forward_port",
    "speed_limit",
    "user_tunnel",
    "vite_config",
    "statistics_flow",
  ];
  for (const t of seqTables) {
    const maxRow = db.sql.exec<{ m: number | null }>(`SELECT MAX(id) AS m FROM "${t}"`).toArray()[0];
    const maxId = maxRow?.m ?? 0;
    const targetSeq = Math.max(maxId, Number(body.sequences?.[t] ?? 0) || 0);
    if (targetSeq > 0) {
      try {
        db.sql.exec("DELETE FROM sqlite_sequence WHERE name = ?", t);
        db.sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", t, targetSeq);
      } catch {
        // 忽略
      }
    }
  }

  // 如果导入了管理员账号且非默认初始密码，标记为已完成初始化
  const admin = db.sql
    .exec<{ user: string; pwd: string }>("SELECT user, pwd FROM user WHERE role_id = 0 ORDER BY id LIMIT 1")
    .toArray()[0];
  if (admin && db.getSetting(SETUP_DONE_KEY) !== "true") {
    db.setSetting(SETUP_DONE_KEY, "true");
  }

  // 确保面板指纹合法
  if (!FINGERPRINT_RE.test(db.getSetting(FINGERPRINT_KEY))) {
    db.panelFingerprint();
  }

  // 可选：同步更新面板地址配置
  if (body.panelAddr && body.panelAddr.trim()) {
    db.upsertConfig("ip", body.panelAddr.trim());
  }

  return handleMigrateStatus(db);
}
