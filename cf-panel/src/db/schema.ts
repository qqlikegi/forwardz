import { md5Hex, newFingerprint } from "../crypto";

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS forward (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name VARCHAR(100) NOT NULL,
    name VARCHAR(100) NOT NULL,
    tunnel_id INTEGER NOT NULL,
    remote_addr TEXT NOT NULL,
    strategy VARCHAR(100) NOT NULL DEFAULT 'fifo',
    in_flow INTEGER NOT NULL DEFAULT 0,
    out_flow INTEGER NOT NULL DEFAULT 0,
    created_time INTEGER NOT NULL,
    updated_time INTEGER NOT NULL,
    status INTEGER NOT NULL,
    inx INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS forward_port (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forward_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    port INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS node (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    secret VARCHAR(100) NOT NULL,
    server_ip VARCHAR(100) NOT NULL,
    port TEXT NOT NULL,
    interface_name VARCHAR(200),
    version VARCHAR(100),
    http INTEGER NOT NULL DEFAULT 0,
    tls INTEGER NOT NULL DEFAULT 0,
    socks INTEGER NOT NULL DEFAULT 0,
    created_time INTEGER NOT NULL,
    updated_time INTEGER,
    status INTEGER NOT NULL,
    tcp_listen_addr VARCHAR(100) NOT NULL DEFAULT '[::]',
    udp_listen_addr VARCHAR(100) NOT NULL DEFAULT '[::]'
  )`,
  `CREATE TABLE IF NOT EXISTS speed_limit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    speed INTEGER NOT NULL,
    tunnel_id INTEGER NOT NULL,
    tunnel_name VARCHAR(100) NOT NULL,
    created_time INTEGER NOT NULL,
    updated_time INTEGER,
    status INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS statistics_flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    flow INTEGER NOT NULL,
    total_flow INTEGER NOT NULL,
    time VARCHAR(100) NOT NULL,
    created_time INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tunnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    traffic_ratio REAL NOT NULL DEFAULT 1.0,
    type INTEGER NOT NULL,
    protocol VARCHAR(10) NOT NULL DEFAULT 'tls',
    flow INTEGER NOT NULL,
    created_time INTEGER NOT NULL,
    updated_time INTEGER NOT NULL,
    status INTEGER NOT NULL,
    in_ip TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chain_tunnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tunnel_id INTEGER NOT NULL,
    chain_type VARCHAR(10) NOT NULL,
    node_id INTEGER NOT NULL,
    port INTEGER,
    strategy VARCHAR(10),
    inx INTEGER,
    protocol VARCHAR(10)
  )`,
  `CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user VARCHAR(100) NOT NULL,
    pwd VARCHAR(100) NOT NULL,
    role_id INTEGER NOT NULL,
    exp_time INTEGER NOT NULL,
    flow INTEGER NOT NULL,
    in_flow INTEGER NOT NULL DEFAULT 0,
    out_flow INTEGER NOT NULL DEFAULT 0,
    flow_reset_time INTEGER NOT NULL,
    num INTEGER NOT NULL,
    created_time INTEGER NOT NULL,
    updated_time INTEGER,
    status INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_tunnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tunnel_id INTEGER NOT NULL,
    speed_id INTEGER,
    num INTEGER NOT NULL,
    flow INTEGER NOT NULL,
    in_flow INTEGER NOT NULL DEFAULT 0,
    out_flow INTEGER NOT NULL DEFAULT 0,
    flow_reset_time INTEGER NOT NULL,
    exp_time INTEGER NOT NULL,
    status INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vite_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(200) NOT NULL UNIQUE,
    value VARCHAR(200) NOT NULL,
    time INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_flow_daily (
    user_id INTEGER NOT NULL,
    day VARCHAR(10) NOT NULL,
    flow INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS system_setting (
    name VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tunnel_latency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tunnel_id INTEGER NOT NULL,
    latency REAL NOT NULL,
    packet_loss REAL NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    created_time INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tunnel_latency_tid_time ON tunnel_latency (tunnel_id, created_time)`,
  `CREATE TABLE IF NOT EXISTS forward_latency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forward_id INTEGER NOT NULL,
    latency REAL NOT NULL,
    packet_loss REAL NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    created_time INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_forward_latency_fid_time ON forward_latency (forward_id, created_time)`,
  `CREATE TABLE IF NOT EXISTS latency_bucket (
    bucket_ms INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  )`,
];

export const SEED_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO user (id, user, pwd, role_id, exp_time, flow, in_flow, out_flow, flow_reset_time, num, created_time, updated_time, status)
   VALUES (1, 'admin_user', '3c85cdebade1c51cf64ca9f3c09d182d', 0, 2727251700000, 99999, 0, 0, 1, 99999, 1748914865000, 1754011744252, 1)`,
  `INSERT OR IGNORE INTO vite_config (id, name, value, time)
   VALUES (1, 'app_name', 'ForwardZ', 1755147963000)`,
];

export const SETUP_DONE_KEY = "admin_initialized";
export const FINGERPRINT_KEY = "panel_fingerprint";
export const FINGERPRINT_RE = /^[A-Za-z0-9]{8}$/;

export function initDatabase(sql: SqlStorage): void {
  for (const stmt of SCHEMA_STATEMENTS) {
    sql.exec(stmt);
  }
  for (const stmt of SEED_STATEMENTS) {
    sql.exec(stmt);
  }

  // 初始化 setup 状态：若管理员已改过默认密码则直接视为已初始化
  const setupRow = sql
    .exec<{ value: string }>("SELECT value FROM system_setting WHERE name = ?", SETUP_DONE_KEY)
    .toArray()[0];
  if (!setupRow || setupRow.value === "") {
    const admin = sql
      .exec<{ user: string; pwd: string }>("SELECT user, pwd FROM user WHERE role_id = 0 ORDER BY id LIMIT 1")
      .toArray()[0];
    if (admin && !(admin.user === "admin_user" && admin.pwd === md5Hex("admin_user"))) {
      sql.exec(
        "INSERT INTO system_setting (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        SETUP_DONE_KEY,
        "true",
      );
    }
  }

  // 确保存在 8 位面板指纹
  const fpRow = sql
    .exec<{ value: string }>("SELECT value FROM system_setting WHERE name = ?", FINGERPRINT_KEY)
    .toArray()[0];
  if (!fpRow || !FINGERPRINT_RE.test(fpRow.value)) {
    sql.exec(
      "INSERT INTO system_setting (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      FINGERPRINT_KEY,
      newFingerprint(),
    );
  }
}
