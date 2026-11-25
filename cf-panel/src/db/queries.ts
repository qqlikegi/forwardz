import { FINGERPRINT_KEY, FINGERPRINT_RE, SETUP_DONE_KEY } from "./schema";
import { newFingerprint } from "../crypto";
import { localCalendarParts } from "../utils/timezone";

// ---------- 实体模型（JSON 字段名与前端/Go 版 100% 一致） ----------

export interface UserRow {
  id: number;
  createdTime: number;
  updatedTime: number | null;
  status: number;
  user: string;
  pwd: string;
  roleId: number;
  expTime: number;
  flow: number;
  inFlow: number;
  outFlow: number;
  num: number;
  flowResetTime: number;
}

export interface NodeRow {
  id: number;
  createdTime: number;
  updatedTime: number | null;
  status: number;
  name: string;
  secret: string | null;
  serverIp: string;
  version: string | null;
  port: string;
  http: number;
  tls: number;
  socks: number;
  interfaceName: string | null;
  tcpListenAddr: string;
  udpListenAddr: string;
}

export interface TunnelRow {
  id: number;
  createdTime: number;
  updatedTime: number;
  status: number;
  name: string;
  type: number;
  flow: number;
  trafficRatio: number;
  inIp: string | null;
}

export interface ChainTunnelRow {
  id: number | null;
  tunnelId: number;
  chainType: number;
  nodeId: number;
  port: number | null;
  strategy: string | null;
  inx: number | null;
  protocol: string | null;
}

export interface ForwardRow {
  id: number;
  createdTime: number;
  updatedTime: number;
  status: number;
  userId: number;
  userName: string;
  name: string;
  tunnelId: number;
  remoteAddr: string;
  strategy: string;
  inFlow: number;
  outFlow: number;
  inx: number;
}

export interface ForwardPortRow {
  id: number;
  forwardId: number;
  nodeId: number;
  port: number;
}

export interface SpeedLimitRow {
  id: number;
  createdTime: number;
  updatedTime: number | null;
  status: number;
  name: string;
  speed: number;
  tunnelId: number;
  tunnelName: string;
}

export interface UserTunnelRow {
  id: number;
  userId: number;
  tunnelId: number;
  flow: number;
  inFlow: number;
  outFlow: number;
  flowResetTime: number;
  expTime: number;
  speedId: number | null;
  num: number;
  status: number;
}

export interface StatisticsFlowRow {
  id: number | null;
  userId: number;
  flow: number;
  totalFlow: number;
  time: string;
  createdTime: number | null;
}

export interface ViteConfigRow {
  id: number;
  name: string;
  value: string;
  time: number;
}

// ---------- SQL 映射辅助 ----------

function asInt(v: unknown, def = 0): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && v !== "") return parseInt(v, 10) || def;
  return def;
}

function asNum(v: unknown, def = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v) || def;
  return def;
}

function asNullInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return asInt(v);
}

function asStr(v: unknown, def = ""): string {
  if (v === null || v === undefined) return def;
  return String(v);
}

function asNullStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function mapUser(r: Record<string, unknown>): UserRow {
  return {
    id: asInt(r.id),
    createdTime: asInt(r.created_time),
    updatedTime: asNullInt(r.updated_time),
    status: asInt(r.status),
    user: asStr(r.user),
    pwd: asStr(r.pwd),
    roleId: asInt(r.role_id),
    expTime: asInt(r.exp_time),
    flow: asInt(r.flow),
    inFlow: asInt(r.in_flow),
    outFlow: asInt(r.out_flow),
    num: asInt(r.num),
    flowResetTime: asInt(r.flow_reset_time),
  };
}

export function sanitizeUser(u: UserRow): Omit<UserRow, "pwd"> {
  const { pwd: _pwd, ...rest } = u;
  return rest;
}

export function mapNode(r: Record<string, unknown>): NodeRow {
  return {
    id: asInt(r.id),
    createdTime: asInt(r.created_time),
    updatedTime: asNullInt(r.updated_time),
    status: asInt(r.status),
    name: asStr(r.name),
    secret: asNullStr(r.secret),
    serverIp: asStr(r.server_ip),
    version: asNullStr(r.version),
    port: asStr(r.port),
    http: asInt(r.http),
    tls: asInt(r.tls),
    socks: asInt(r.socks),
    interfaceName: asNullStr(r.interface_name),
    tcpListenAddr: asStr(r.tcp_listen_addr, "[::]"),
    udpListenAddr: asStr(r.udp_listen_addr, "[::]"),
  };
}

export function mapTunnel(r: Record<string, unknown>): TunnelRow {
  return {
    id: asInt(r.id),
    createdTime: asInt(r.created_time),
    updatedTime: asInt(r.updated_time),
    status: asInt(r.status),
    name: asStr(r.name),
    type: asInt(r.type),
    flow: asInt(r.flow),
    trafficRatio: asNum(r.traffic_ratio, 1.0),
    inIp: asNullStr(r.in_ip),
  };
}

export function mapChain(r: Record<string, unknown>): ChainTunnelRow {
  return {
    id: asNullInt(r.id),
    tunnelId: asInt(r.tunnel_id),
    chainType: asInt(r.chain_type),
    nodeId: asInt(r.node_id),
    port: asNullInt(r.port),
    strategy: asNullStr(r.strategy),
    inx: asNullInt(r.inx),
    protocol: asNullStr(r.protocol),
  };
}

export function mapForward(r: Record<string, unknown>): ForwardRow {
  return {
    id: asInt(r.id),
    createdTime: asInt(r.created_time),
    updatedTime: asInt(r.updated_time),
    status: asInt(r.status),
    userId: asInt(r.user_id),
    userName: asStr(r.user_name),
    name: asStr(r.name),
    tunnelId: asInt(r.tunnel_id),
    remoteAddr: asStr(r.remote_addr),
    strategy: asStr(r.strategy, "fifo"),
    inFlow: asInt(r.in_flow),
    outFlow: asInt(r.out_flow),
    inx: asInt(r.inx),
  };
}

export function mapForwardPort(r: Record<string, unknown>): ForwardPortRow {
  return {
    id: asInt(r.id),
    forwardId: asInt(r.forward_id),
    nodeId: asInt(r.node_id),
    port: asInt(r.port),
  };
}

export function mapSpeed(r: Record<string, unknown>): SpeedLimitRow {
  return {
    id: asInt(r.id),
    createdTime: asInt(r.created_time),
    updatedTime: asNullInt(r.updated_time),
    status: asInt(r.status),
    name: asStr(r.name),
    speed: asInt(r.speed),
    tunnelId: asInt(r.tunnel_id),
    tunnelName: asStr(r.tunnel_name),
  };
}

export function mapUserTunnel(r: Record<string, unknown>): UserTunnelRow {
  return {
    id: asInt(r.id),
    userId: asInt(r.user_id),
    tunnelId: asInt(r.tunnel_id),
    flow: asInt(r.flow),
    inFlow: asInt(r.in_flow),
    outFlow: asInt(r.out_flow),
    flowResetTime: asInt(r.flow_reset_time),
    expTime: asInt(r.exp_time),
    speedId: asNullInt(r.speed_id),
    num: asInt(r.num),
    status: asInt(r.status),
  };
}

// ---------- 常用查询封装 ----------

export class PanelDB {
  constructor(public readonly sql: SqlStorage) {}

  countOf(query: string, ...args: unknown[]): number {
    const row = this.sql.exec<Record<string, SqlStorageValue>>(query, ...args).toArray()[0];
    if (!row) return 0;
    const firstVal = Object.values(row)[0];
    return asInt(firstVal, 0);
  }

  lastInsertId(): number {
    const row = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one();
    return asInt(row.id);
  }

  getSetting(name: string): string {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM system_setting WHERE name = ?", name)
      .toArray()[0];
    return row ? row.value : "";
  }

  setSetting(name: string, value: string): void {
    this.sql.exec(
      "INSERT INTO system_setting (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value,
    );
  }

  needSetup(): boolean {
    return this.getSetting(SETUP_DONE_KEY) !== "true";
  }

  panelFingerprint(): string {
    const cur = this.getSetting(FINGERPRINT_KEY);
    if (FINGERPRINT_RE.test(cur)) return cur;
    const fp = newFingerprint();
    this.setSetting(FINGERPRINT_KEY, fp);
    return fp;
  }

  getConfigValue(name: string): string | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM vite_config WHERE name = ?", name)
      .toArray()[0];
    return row ? row.value : null;
  }

  upsertConfig(name: string, value: string): void {
    this.sql.exec(
      `INSERT INTO vite_config (name, value, time) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, time = excluded.time`,
      name,
      value,
      Date.now(),
    );
  }

  getUser(id: number): UserRow | null {
    const r = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM user WHERE id = ?", id).toArray()[0];
    return r ? mapUser(r) : null;
  }

  getUserByName(name: string): UserRow | null {
    const r = this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM user WHERE user = ? LIMIT 1", name)
      .toArray()[0];
    return r ? mapUser(r) : null;
  }

  listUsers(where = "", ...args: unknown[]): UserRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM user ${where}`, ...args)
      .toArray()
      .map(mapUser);
  }

  getNode(id: number): NodeRow | null {
    const r = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM node WHERE id = ?", id).toArray()[0];
    return r ? mapNode(r) : null;
  }

  getNodeBySecret(secret: string): NodeRow | null {
    if (!secret) return null;
    const r = this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM node WHERE secret = ? LIMIT 1", secret)
      .toArray()[0];
    return r ? mapNode(r) : null;
  }

  listNodes(where = "", ...args: unknown[]): NodeRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM node ${where}`, ...args)
      .toArray()
      .map(mapNode);
  }

  getTunnel(id: number): TunnelRow | null {
    const r = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM tunnel WHERE id = ?", id).toArray()[0];
    return r ? mapTunnel(r) : null;
  }

  listTunnels(where = "", ...args: unknown[]): TunnelRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM tunnel ${where}`, ...args)
      .toArray()
      .map(mapTunnel);
  }

  listChains(where = "", ...args: unknown[]): ChainTunnelRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM chain_tunnel ${where}`, ...args)
      .toArray()
      .map(mapChain);
  }

  entryChains(tunnelId: number): ChainTunnelRow[] {
    return this.listChains(
      "WHERE tunnel_id = ? AND CAST(chain_type AS INTEGER) = 1 ORDER BY id",
      tunnelId,
    );
  }

  getForward(id: number): ForwardRow | null {
    const r = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM forward WHERE id = ?", id).toArray()[0];
    return r ? mapForward(r) : null;
  }

  listForwards(where = "", ...args: unknown[]): ForwardRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM forward ${where}`, ...args)
      .toArray()
      .map(mapForward);
  }

  listForwardPorts(where = "", ...args: unknown[]): ForwardPortRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM forward_port ${where}`, ...args)
      .toArray()
      .map(mapForwardPort);
  }

  getSpeedLimit(id: number): SpeedLimitRow | null {
    const r = this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM speed_limit WHERE id = ?", id)
      .toArray()[0];
    return r ? mapSpeed(r) : null;
  }

  listSpeedLimits(): SpeedLimitRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM speed_limit")
      .toArray()
      .map(mapSpeed);
  }

  getUserTunnelById(id: number): UserTunnelRow | null {
    const r = this.sql
      .exec<Record<string, SqlStorageValue>>("SELECT * FROM user_tunnel WHERE id = ?", id)
      .toArray()[0];
    return r ? mapUserTunnel(r) : null;
  }

  getUserTunnel(userId: number, tunnelId: number): UserTunnelRow | null {
    const r = this.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM user_tunnel WHERE user_id = ? AND tunnel_id = ? ORDER BY id LIMIT 1",
        userId,
        tunnelId,
      )
      .toArray()[0];
    return r ? mapUserTunnel(r) : null;
  }

  listUserTunnels(where = "", ...args: unknown[]): UserTunnelRow[] {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM user_tunnel ${where}`, ...args)
      .toArray()
      .map(mapUserTunnel);
  }

  usedPorts(nodeId: number, excludeForwardId: number): Set<number> {
    const used = new Set<number>();
    for (const ct of this.listChains("WHERE node_id = ?", nodeId)) {
      if (ct.port !== null) used.add(ct.port);
    }
    for (const fp of this.listForwardPorts(
      "WHERE node_id = ? AND forward_id != ?",
      nodeId,
      excludeForwardId,
    )) {
      used.add(fp.port);
    }
    return used;
  }

  relatedNodeIds(nodeId: number): number[] {
    const set = new Set<number>([nodeId]);
    const rows = this.sql
      .exec<{ node_id: number }>(
        "SELECT DISTINCT b.node_id FROM chain_tunnel a JOIN chain_tunnel b ON a.tunnel_id = b.tunnel_id WHERE a.node_id = ?",
        nodeId,
      )
      .toArray();
    for (const r of rows) set.add(asInt(r.node_id));
    return Array.from(set);
  }

  tunnelsWithEntry(nodeId: number): TunnelRow[] {
    return this.listTunnels(
      "WHERE id IN (SELECT tunnel_id FROM chain_tunnel WHERE node_id = ? AND CAST(chain_type AS INTEGER) = 1)",
      nodeId,
    );
  }

  entryIPs(tunnelId: number): string {
    const ips: string[] = [];
    for (const ct of this.entryChains(tunnelId)) {
      const n = this.getNode(ct.nodeId);
      if (n) ips.push(n.serverIp);
    }
    return ips.join(",");
  }

  tunnelNodeIds(tunnelId: number): number[] {
    const ids: number[] = [];
    for (const ct of this.listChains("WHERE tunnel_id = ? ORDER BY id", tunnelId)) {
      if (this.getNode(ct.nodeId)) ids.push(ct.nodeId);
    }
    return ids;
  }

  forwardEntryAddress(
    forwardId: number,
    tunnelId: number,
  ): { inIp: string; inPort: number | null; found: boolean } {
    const tunnel = this.getTunnel(tunnelId);
    if (!tunnel) return { inIp: "", inPort: null, found: false };
    const ports = this.listForwardPorts("WHERE forward_id = ? ORDER BY id", forwardId);
    if (ports.length === 0) return { inIp: "", inPort: null, found: false };

    const set: string[] = [];
    const seen = new Set<string>();
    const add = (s: string) => {
      if (!seen.has(s)) {
        seen.add(s);
        set.push(s);
      }
    };

    const rawInIp = (tunnel.inIp ?? "").trim();
    if (rawInIp !== "") {
      const ips: string[] = [];
      const ipSeen = new Set<string>();
      for (const part of rawInIp.split(",")) {
        const ip = part.trim();
        if (ip && !ipSeen.has(ip)) {
          ipSeen.add(ip);
          ips.push(ip);
        }
      }
      const uniqPorts: number[] = [];
      const portSeen = new Set<number>();
      for (const p of ports) {
        if (!portSeen.has(p.port)) {
          portSeen.add(p.port);
          uniqPorts.push(p.port);
        }
      }
      for (const ip of ips) {
        for (const p of uniqPorts) {
          add(`${ip}:${p}`);
        }
      }
      return { inIp: set.join(","), inPort: uniqPorts.length > 0 ? uniqPorts[0] : null, found: true };
    }

    for (const p of ports) {
      const n = this.getNode(p.nodeId);
      if (n) add(`${n.serverIp}:${p.port}`);
    }
    return { inIp: set.join(","), inPort: ports[0].port, found: true };
  }

  last24HoursFlow(userId: number, tzOffsetMin: number): StatisticsFlowRow[] {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT id, user_id, flow, total_flow, time, created_time FROM statistics_flow WHERE user_id = ? ORDER BY id DESC LIMIT 24",
        userId,
      )
      .toArray();
    const list: StatisticsFlowRow[] = rows.map((r) => ({
      id: asNullInt(r.id),
      userId: asInt(r.user_id),
      flow: asInt(r.flow),
      totalFlow: asInt(r.total_flow),
      time: asStr(r.time),
      createdTime: asNullInt(r.created_time),
    }));
    if (list.length < 24) {
      let hour = localCalendarParts(Date.now(), tzOffsetMin).hour;
      if (list.length > 0) {
        const idx = list[list.length - 1].time.indexOf(":");
        if (idx > 0) {
          const parsed = parseInt(list[list.length - 1].time.slice(0, idx), 10);
          if (!Number.isNaN(parsed)) hour = parsed - 1;
        }
      }
      while (list.length < 24) {
        if (hour < 0) hour = 23;
        list.push({
          id: null,
          userId,
          flow: 0,
          totalFlow: 0,
          time: `${hour < 10 ? "0" : ""}${hour}:00`,
          createdTime: null,
        });
        hour--;
      }
    }
    return list;
  }
}

export function groupChains(chains: ChainTunnelRow[]): {
  inNodes: ChainTunnelRow[];
  hops: ChainTunnelRow[][];
  outNodes: ChainTunnelRow[];
} {
  const inNodes: ChainTunnelRow[] = [];
  const outNodes: ChainTunnelRow[] = [];
  const byInx = new Map<number, ChainTunnelRow[]>();
  for (const ct of chains) {
    if (ct.chainType === 1) {
      inNodes.push(ct);
    } else if (ct.chainType === 2) {
      const k = ct.inx ?? 0;
      const arr = byInx.get(k) ?? [];
      arr.push(ct);
      byInx.set(k, arr);
    } else {
      outNodes.push(ct);
    }
  }
  const keys = Array.from(byInx.keys()).sort((a, b) => a - b);
  const hops = keys.map((k) => byInx.get(k)!);
  return { inNodes, hops, outNodes };
}

export function serviceName(forwardId: number, userId: number, ut: UserTunnelRow | null): string {
  return `${forwardId}_${userId}_${ut ? ut.id : 0}`;
}
