import {
  agentAddLimiter,
  agentAddOrUpdateService,
  agentDeleteLimiter,
  agentDeleteService,
  agentPauseResume,
  agentUpdateLimiter,
  type AgentMessenger,
  forwardServiceNames,
  resultOk,
  speedToMBps,
} from "../agent/commands";
import { type Claims, md5Hex } from "../crypto";
import {
  type ChainTunnelRow,
  type ForwardRow,
  type NodeRow,
  type PanelDB,
  serviceName,
  type TunnelRow,
  type UserTunnelRow,
} from "../db/queries";
import {
  BizError,
  BYTES_PER_GB,
  fail,
  minVal,
  notBlank,
  notNull,
  numInt,
  numPtr,
  ok,
  paramInt,
  parseNum,
  parsePorts,
  parseStr,
  type R,
  splitHostPort,
  throwBiz,
} from "../utils/validation";
import { diagnoseChain, type DiagResult, tcpPing, tunnelTypeName } from "./tunnel";

export interface Actor {
  userId: number;
  roleId: number;
  name: string;
}

export const ADMIN_ACTOR: Actor = { userId: 0, roleId: 0, name: "" };

export function actorOf(c: Claims): Actor {
  return { userId: c.userId, roleId: c.roleId, name: c.name };
}

export interface ForwardRouteDeps {
  db: PanelDB;
  messenger: AgentMessenger;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

function ownForward(db: PanelDB, id: number, a: Actor): ForwardRow | null {
  const f = db.getForward(id);
  if (!f || (a.roleId !== 0 && a.userId !== f.userId)) return null;
  return f;
}

export function handleForwardList(db: PanelDB, claims: Claims): R {
  let q = `SELECT f.id, f.user_id, f.name, f.tunnel_id, f.remote_addr, f.status, f.created_time, f.updated_time,
                  f.user_name, f.in_flow, f.out_flow, f.strategy, f.inx, t.name AS tunnel_name
           FROM forward f LEFT JOIN tunnel t ON f.tunnel_id = t.id`;
  const args: unknown[] = [];
  if (claims.roleId !== 0) {
    q += " WHERE f.user_id = ?";
    args.push(claims.userId);
  }
  const rows = db.sql
    .exec<Record<string, SqlStorageValue>>(`${q} ORDER BY f.created_time DESC`, ...args)
    .toArray();

  const out = rows.map((r) => {
    const id = Number(r.id);
    const tunnelId = Number(r.tunnel_id);
    const m: Record<string, unknown> = {
      id,
      name: r.name,
      inIp: null,
      inPort: null,
      remoteAddr: r.remote_addr,
      status: r.status,
      createdTime: r.created_time,
      updatedTime: r.updated_time,
      tunnelName: r.tunnel_name ?? null,
      userName: r.user_name,
      userId: r.user_id,
      tunnelId,
      inFlow: r.in_flow,
      outFlow: r.out_flow,
      strategy: r.strategy,
      inx: r.inx,
    };
    const addr = db.forwardEntryAddress(id, tunnelId);
    if (addr.found) {
      m.inPort = addr.inPort;
      if (addr.inIp) m.inIp = addr.inIp;
    }
    return m;
  });
  return ok(out);
}

function checkPermission(
  db: PanelDB,
  a: Actor,
  tunnel: TunnelRow,
  excludeForwardId: number,
): { limiter: number | null; ut: UserTunnelRow | null; errMsg: string } {
  if (a.roleId === 0) return { limiter: null, ut: null, errMsg: "" };
  const u = db.getUser(a.userId);
  if (!u) return { limiter: null, ut: null, errMsg: "用户不存在" };
  const now = Date.now();
  if (u.expTime <= now) return { limiter: null, ut: null, errMsg: "当前账号已到期" };
  const ut = db.getUserTunnel(a.userId, tunnel.id);
  if (!ut) return { limiter: null, ut: null, errMsg: "你没有该隧道权限" };
  if (ut.status !== 1) return { limiter: null, ut: null, errMsg: "隧道被禁用" };
  if (ut.expTime <= now) return { limiter: null, ut: null, errMsg: "该隧道权限已到期" };
  if (u.flow <= 0) return { limiter: null, ut: null, errMsg: "用户总流量已用完" };
  if (ut.flow <= 0) return { limiter: null, ut: null, errMsg: "该隧道流量已用完" };

  const totalCount = db.countOf(
    "SELECT COUNT(*) FROM forward WHERE user_id = ? AND id != ?",
    a.userId,
    excludeForwardId,
  );
  if (totalCount >= u.num) {
    return { limiter: null, ut: null, errMsg: `用户总转发数量已达上限，当前限制：${u.num}个` };
  }
  const tunnelCount = db.countOf(
    "SELECT COUNT(*) FROM forward WHERE user_id = ? AND tunnel_id = ? AND id != ?",
    a.userId,
    tunnel.id,
    excludeForwardId,
  );
  if (tunnelCount >= ut.num) {
    return { limiter: null, ut: null, errMsg: `该隧道转发数量已达上限，当前限制：${ut.num}个` };
  }
  return { limiter: ut.speedId, ut, errMsg: "" };
}

function availablePorts(db: PanelDB, nodeId: number, forwardId: number): number[] {
  const node = db.getNode(nodeId);
  if (!node) throwBiz("节点不存在");
  const used = db.usedPorts(nodeId, forwardId);
  return parsePorts(node.port).filter((p) => !used.has(p));
}

function pickPorts(
  db: PanelDB,
  chains: ChainTunnelRow[],
  inPort: number | null,
  forwardId: number,
): void {
  const lists: number[][] = [];
  for (const ct of chains) {
    const ports = availablePorts(db, ct.nodeId, forwardId);
    if (ports.length === 0) throwBiz("暂无可用端口");
    lists.push(ports);
  }
  if (inPort !== null) {
    for (const ports of lists) {
      if (!ports.includes(inPort)) {
        throwBiz(`指定端口 ${inPort} 不可用（并非所有节点都有此端口）`);
      }
    }
    for (const ct of chains) ct.port = inPort;
    return;
  }

  let common = new Set<number>(lists[0]);
  for (const ports of lists.slice(1)) {
    const next = new Set<number>();
    for (const p of ports) {
      if (common.has(p)) next.add(p);
    }
    common = next;
  }
  if (common.size > 0) {
    let min = -1;
    for (const p of common) {
      if (min === -1 || p < min) min = p;
    }
    for (const ct of chains) ct.port = min;
    return;
  }
  for (let i = 0; i < chains.length; i++) {
    chains[i].port = lists[i][0];
  }
}

export async function handleForwardCreate(
  deps: ForwardRouteDeps,
  claims: Claims,
  body: Record<string, unknown>,
): Promise<R> {
  const name = parseStr(body.name);
  const tunnelId = parseNum(body.tunnelId);
  const remoteAddr = parseStr(body.remoteAddr);
  const strategy = parseStr(body.strategy);
  const inPort = parseNum(body.inPort);

  notBlank(name, "转发名称不能为空");
  notNull(tunnelId, "隧道ID不能为空");
  notBlank(remoteAddr, "远程地址不能为空");

  return deps.withLock(async () => {
    const a = actorOf(claims);
    const tunnel = deps.db.getTunnel(numInt(tunnelId));
    if (!tunnel) return fail("隧道不存在");
    if (tunnel.status !== 1) return fail("隧道已禁用，无法创建转发");

    const perm = checkPermission(deps.db, a, tunnel, 0);
    if (perm.errMsg) return fail(perm.errMsg);

    const chains = deps.db.entryChains(tunnel.id);
    if (chains.length === 0) return fail("隧道没有入口节点");
    pickPorts(deps.db, chains, numPtr(inPort), 0);

    const nodes = new Map<number, NodeRow>();
    for (const ct of chains) {
      const n = deps.db.getNode(ct.nodeId);
      if (!n) return fail("部分节点不存在");
      nodes.set(n.id, n);
    }

    const now = Date.now();
    const strat = strategy.valid ? strategy.v : "fifo";
    deps.db.sql.exec(
      `INSERT INTO forward (user_id, user_name, name, tunnel_id, remote_addr, strategy, in_flow, out_flow, created_time, updated_time, status, inx)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, 0)`,
      a.userId,
      a.name,
      name.v,
      tunnel.id,
      remoteAddr.v,
      strat,
      now,
      now,
    );
    const id = deps.db.lastInsertId();
    const f = deps.db.getForward(id)!;
    const svcName = serviceName(id, a.userId, perm.ut);

    const okNodes: number[] = [];
    for (const ct of chains) {
      const node = nodes.get(ct.nodeId)!;
      const p = ct.port ?? 0;
      deps.db.sql.exec(
        "INSERT INTO forward_port (forward_id, node_id, port) VALUES (?, ?, ?)",
        id,
        node.id,
        p,
      );
      const r = await agentAddOrUpdateService(
        deps.messenger,
        svcName,
        perm.limiter,
        node,
        f,
        p,
        tunnel,
        "AddService",
      );
      if (!resultOk(r)) {
        for (const n of okNodes) {
          await agentDeleteService(deps.messenger, n, forwardServiceNames(svcName));
        }
        deps.db.sql.exec("DELETE FROM forward_port WHERE forward_id = ?", id);
        deps.db.sql.exec("DELETE FROM forward WHERE id = ?", id);
        return fail(r.msg);
      }
      okNodes.push(node.id);
    }
    return ok();
  });
}

export async function applyForwardUpdate(
  deps: ForwardRouteDeps,
  f: ForwardRow,
  a: Actor,
  inPort: number | null,
): Promise<string> {
  const tunnel = deps.db.getTunnel(f.tunnelId);
  if (!tunnel) return "隧道不存在";
  const perm = checkPermission(deps.db, a, tunnel, f.id);
  if (perm.errMsg) return perm.errMsg;
  const ut = deps.db.getUserTunnel(f.userId, tunnel.id);
  if (a.roleId !== 0 && !ut) return "你没有该隧道权限";
  const limiter = ut ? ut.speedId : null;
  const svcName = serviceName(f.id, f.userId, ut);
  const chains = deps.db.entryChains(tunnel.id);
  if (chains.length === 0) return "隧道没有入口节点";

  const existing = deps.db.listForwardPorts("WHERE forward_id = ? ORDER BY id", f.id);
  const byNode = new Map<number, (typeof existing)[number]>();
  for (const p of existing) byNode.set(p.nodeId, p);
  const current = existing.length > 0 ? existing[0].port : null;
  const unchanged = inPort === null || (current !== null && inPort === current);
  const allHave = chains.every((ct) => byNode.has(ct.nodeId));
  if (unchanged && allHave) {
    for (const ct of chains) ct.port = byNode.get(ct.nodeId)!.port;
  } else {
    pickPorts(deps.db, chains, inPort, f.id);
  }

  const nodes = new Map<number, NodeRow>();
  for (const ct of chains) {
    const n = deps.db.getNode(ct.nodeId);
    if (!n) return "部分节点不存在";
    nodes.set(n.id, n);
  }

  const wasPaused = f.status === 0;
  if (!f.strategy) f.strategy = "fifo";
  deps.db.sql.exec(
    "UPDATE forward SET name = ?, remote_addr = ?, strategy = ?, updated_time = ? WHERE id = ?",
    f.name,
    f.remoteAddr,
    f.strategy,
    Date.now(),
    f.id,
  );

  for (const ct of chains) {
    const node = nodes.get(ct.nodeId)!;
    const p = ct.port ?? 0;
    let r = await agentAddOrUpdateService(
      deps.messenger,
      svcName,
      limiter,
      node,
      f,
      p,
      tunnel,
      "UpdateService",
    );
    if (r.msg.includes("not found")) {
      r = await agentAddOrUpdateService(
        deps.messenger,
        svcName,
        limiter,
        node,
        f,
        p,
        tunnel,
        "AddService",
      );
    }
    if (!resultOk(r)) return r.msg;
    const fp = byNode.get(node.id);
    if (fp) {
      deps.db.sql.exec("UPDATE forward_port SET port = ? WHERE id = ?", p, fp.id);
    } else {
      deps.db.sql.exec(
        "INSERT INTO forward_port (forward_id, node_id, port) VALUES (?, ?, ?)",
        f.id,
        node.id,
        p,
      );
    }
    if (wasPaused) {
      await agentPauseResume(deps.messenger, node.id, svcName, "PauseService");
    }
  }
  return "";
}

export async function syncForward(
  deps: ForwardRouteDeps,
  f: ForwardRow,
  inPort: number | null,
): Promise<string> {
  return deps.withLock(async () => {
    try {
      return await applyForwardUpdate(deps, f, ADMIN_ACTOR, inPort);
    } catch (e) {
      if (e instanceof BizError) return e.message;
      throw e;
    }
  });
}

export async function handleForwardUpdate(
  deps: ForwardRouteDeps,
  claims: Claims,
  body: Record<string, unknown>,
): Promise<R> {
  const id = parseNum(body.id);
  const userId = parseNum(body.userId);
  const name = parseStr(body.name);
  const remoteAddr = parseStr(body.remoteAddr);
  const strategy = parseStr(body.strategy);
  const inPort = parseNum(body.inPort);

  notNull(id, "ID不能为空");
  notNull(userId, "用户ID不能为空");
  notBlank(name, "转发名称不能为空");
  notBlank(remoteAddr, "远程地址不能为空");

  return deps.withLock(async () => {
    const a = actorOf(claims);
    const f = ownForward(deps.db, numInt(id), a);
    if (!f) return fail("转发不存在");
    f.name = name.v;
    f.remoteAddr = remoteAddr.v;
    if (strategy.valid) f.strategy = strategy.v;
    const msg = await applyForwardUpdate(deps, f, a, numPtr(inPort));
    if (msg) return fail(msg);
    return ok();
  });
}

export async function deleteForwardInternal(deps: ForwardRouteDeps, f: ForwardRow): Promise<void> {
  const svcName = serviceName(f.id, f.userId, deps.db.getUserTunnel(f.userId, f.tunnelId));
  const nodeIds: number[] = [];
  const seen = new Set<number>();
  for (const p of deps.db.listForwardPorts("WHERE forward_id = ? ORDER BY id", f.id)) {
    if (!seen.has(p.nodeId)) {
      seen.add(p.nodeId);
      nodeIds.push(p.nodeId);
    }
  }
  if (nodeIds.length === 0) {
    for (const ct of deps.db.entryChains(f.tunnelId)) {
      nodeIds.push(ct.nodeId);
    }
  }
  for (const nid of nodeIds) {
    await agentDeleteService(deps.messenger, nid, forwardServiceNames(svcName));
  }
  deps.db.sql.exec("DELETE FROM forward_port WHERE forward_id = ?", f.id);
  deps.db.sql.exec("DELETE FROM forward WHERE id = ?", f.id);
}

export async function handleForwardDelete(
  deps: ForwardRouteDeps,
  claims: Claims,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  return deps.withLock(async () => {
    const f = ownForward(deps.db, id, actorOf(claims));
    if (!f) return fail("转发不存在");
    await deleteForwardInternal(deps, f);
    return ok();
  });
}

export function handleForwardForceDelete(
  db: PanelDB,
  claims: Claims,
  body: Record<string, unknown>,
): R {
  const id = paramInt(body, "id");
  if (!ownForward(db, id, actorOf(claims))) return fail("端口转发不存在");
  db.sql.exec("DELETE FROM forward WHERE id = ?", id);
  db.sql.exec("DELETE FROM forward_port WHERE forward_id = ?", id);
  return ok();
}

function checkFlowLimits(db: PanelDB, userId: number, tunnel: TunnelRow): string {
  const u = db.getUser(userId);
  if (!u) return "用户不存在";
  const now = Date.now();
  if (u.expTime <= now) return "当前账号已到期";
  const ut = db.getUserTunnel(userId, tunnel.id);
  if (!ut) return "你没有该隧道权限";
  if (ut.expTime <= now) return "该隧道权限已到期，无法恢复服务";
  if (u.flow * BYTES_PER_GB <= u.inFlow + u.outFlow) return "用户总流量已用完，无法恢复服务";
  if (ut.flow * BYTES_PER_GB <= ut.inFlow + ut.outFlow) return "该隧道流量已用完，无法恢复服务";
  return "";
}

export async function changeForwardStatus(
  deps: ForwardRouteDeps,
  claims: Claims,
  id: number,
  target: 0 | 1,
  method: "PauseService" | "ResumeService",
): Promise<R> {
  const a = actorOf(claims);
  if (a.roleId !== 0) {
    const u = deps.db.getUser(a.userId);
    if (!u) return fail("用户不存在");
    if (u.status === 0) return fail("用户已到期或被禁用");
  }
  const f = ownForward(deps.db, id, a);
  if (!f) return fail("转发不存在");
  const tunnel = deps.db.getTunnel(f.tunnelId);
  if (!tunnel) return fail("隧道不存在");

  let ut: UserTunnelRow | null = null;
  if (target === 1) {
    if (tunnel.status !== 1) return fail("隧道已禁用，无法恢复服务");
    if (a.roleId !== 0) {
      const msg = checkFlowLimits(deps.db, a.userId, tunnel);
      if (msg) return fail(msg);
      ut = deps.db.getUserTunnel(a.userId, tunnel.id);
      if (!ut) return fail("你没有该隧道权限");
      if (ut.status !== 1) return fail("隧道被禁用");
    }
  }
  if (a.roleId !== 0 && !ut) {
    ut = deps.db.getUserTunnel(a.userId, tunnel.id);
    if (!ut) return fail("你没有该隧道权限");
  }
  if (!ut) ut = deps.db.getUserTunnel(f.userId, tunnel.id);

  const svcName = serviceName(f.id, f.userId, ut);
  for (const ct of deps.db.entryChains(tunnel.id)) {
    const node = deps.db.getNode(ct.nodeId);
    if (!node) return fail("部分节点不存在");
    const r = await agentPauseResume(deps.messenger, node.id, svcName, method);
    if (!resultOk(r)) return fail(r.msg);
  }
  deps.db.sql.exec("UPDATE forward SET status = ?, updated_time = ? WHERE id = ?", target, Date.now(), f.id);
  return ok();
}

export async function handleForwardDiagnose(
  deps: ForwardRouteDeps,
  claims: Claims,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "forwardId");
  const f = ownForward(deps.db, id, actorOf(claims));
  if (!f) return fail("转发不存在");
  const tunnel = deps.db.getTunnel(f.tunnelId);
  if (!tunnel) return fail("隧道不存在");
  const chains = deps.db.listChains("WHERE tunnel_id = ? ORDER BY id", tunnel.id);
  if (chains.length === 0) return fail("隧道配置不完整");

  const remotes = f.remoteAddr.split(",");
  const results = await diagnoseChain(deps.db, deps.messenger, tunnel, chains, async (n, from) => {
    const label = from === 3 ? "出口" : "入口";
    const tasks: Promise<DiagResult>[] = [];
    for (const ra of remotes) {
      const [ip, port] = splitHostPort(ra);
      if (!ip || port === -1) continue;
      tasks.push(
        tcpPing(deps.messenger, n, ip, port, `${label}(${n.name})->目标(${ra})`).then((r) => ({
          ...r,
          fromChainType: from,
        })),
      );
    }
    return Promise.all(tasks);
  });

  return ok({
    forwardId: id,
    forwardName: f.name,
    tunnelType: tunnelTypeName(tunnel.type),
    results,
    timestamp: Date.now(),
  });
}

export function handleForwardUpdateOrder(
  db: PanelDB,
  claims: Claims,
  body: Record<string, unknown>,
): R {
  if (!Object.prototype.hasOwnProperty.call(body, "forwards")) {
    return fail("缺少forwards参数");
  }
  const raw = body.forwards;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("forwards参数不能为空");
  }
  const orders = raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throwBiz("forwards参数格式错误");
    }
    const m = item as Record<string, unknown>;
    return { id: paramInt(m, "id"), inx: paramInt(m, "inx") };
  });

  if (claims.roleId !== 0) {
    const ids = orders.map((o) => o.id).join(",");
    const n = db.countOf(
      `SELECT COUNT(*) FROM forward WHERE user_id = ? AND id IN (${ids})`,
      claims.userId,
    );
    if (n !== orders.length) return fail("只能更新自己的转发排序");
  }

  for (const o of orders) {
    db.sql.exec("UPDATE forward SET inx = ? WHERE id = ?", o.inx, o.id);
  }
  return ok();
}

// ---------- 限速规则 ----------

export async function handleSpeedCreate(
  deps: ForwardRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const name = parseStr(body.name);
  const speed = parseNum(body.speed);
  const tunnelId = parseNum(body.tunnelId);
  const tunnelName = parseStr(body.tunnelName);
  notBlank(name, "限速规则名称不能为空");
  notNull(speed, "速度限制不能为空");
  minVal(speed, 1, "速度限制必须大于0");
  notNull(tunnelId, "隧道ID不能为空");
  notBlank(tunnelName, "隧道名称不能为空");

  const tid = numInt(tunnelId);
  if (!deps.db.getTunnel(tid)) return fail("隧道不存在");
  const now = Date.now();
  deps.db.sql.exec(
    "INSERT INTO speed_limit (name, speed, tunnel_id, tunnel_name, created_time, updated_time, status) VALUES (?, ?, ?, ?, ?, ?, 1)",
    name.v,
    numInt(speed),
    tid,
    tunnelName.v,
    now,
    now,
  );
  const id = deps.db.lastInsertId();
  const speedStr = speedToMBps(numInt(speed));

  const okNodes: number[] = [];
  for (const nodeId of deps.db.tunnelNodeIds(tid)) {
    const r = await agentAddLimiter(deps.messenger, nodeId, id, speedStr);
    if (!resultOk(r)) {
      deps.db.sql.exec("DELETE FROM speed_limit WHERE id = ?", id);
      for (const n of okNodes) {
        await agentDeleteLimiter(deps.messenger, n, id);
      }
      return fail(r.msg);
    }
    okNodes.push(nodeId);
  }
  return ok();
}

export function handleSpeedList(db: PanelDB): R {
  return ok(db.listSpeedLimits());
}

export async function handleSpeedUpdate(
  deps: ForwardRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = parseNum(body.id);
  const name = parseStr(body.name);
  const speed = parseNum(body.speed);
  notNull(id, "ID不能为空");
  notBlank(name, "限速规则名称不能为空");
  notNull(speed, "速度限制不能为空");
  minVal(speed, 1, "速度限制必须大于0");

  const l = deps.db.getSpeedLimit(numInt(id));
  if (!l) return fail("限速不存在");
  const speedStr = speedToMBps(numInt(speed));
  for (const nodeId of deps.db.tunnelNodeIds(l.tunnelId)) {
    const r = await agentUpdateLimiter(deps.messenger, nodeId, l.id, speedStr);
    if (!resultOk(r)) return fail(r.msg);
  }
  deps.db.sql.exec(
    "UPDATE speed_limit SET name = ?, speed = ?, updated_time = ? WHERE id = ?",
    name.v,
    numInt(speed),
    Date.now(),
    l.id,
  );
  return ok();
}

export async function handleSpeedDelete(
  deps: ForwardRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  const l = deps.db.getSpeedLimit(id);
  if (!l) return fail("限速规则不存在");
  if (deps.db.countOf("SELECT COUNT(*) FROM user_tunnel WHERE speed_id = ?", id) !== 0) {
    return fail("该限速规则还有用户在使用 请先取消分配");
  }
  for (const nodeId of deps.db.tunnelNodeIds(l.tunnelId)) {
    const r = await agentDeleteLimiter(deps.messenger, nodeId, id);
    if (!resultOk(r)) return fail(r.msg);
  }
  deps.db.sql.exec("DELETE FROM speed_limit WHERE id = ?", id);
  return ok();
}

// ---------- Sub-Store 订阅信息 ----------

export function handleOpenSubStore(
  db: PanelDB,
  url: URL,
): { r?: R; text?: string; header?: string } {
  const user = url.searchParams.get("user") ?? "";
  const pwd = url.searchParams.get("pwd") ?? "";
  const tunnel = url.searchParams.get("tunnel") || "-1";
  if (!user) return { r: fail("用户不能为空") };
  if (!pwd) return { r: fail("密码不能为空") };
  const u = db.getUserByName(user);
  if (!u || u.pwd !== md5Hex(pwd)) return { r: fail("鉴权失败") };

  const fmt = (upload: number, download: number, total: number, expire: number) =>
    `upload=${download}; download=${upload}; total=${total}; expire=${expire}`;

  let value: string;
  if (tunnel === "-1") {
    value = fmt(u.outFlow, u.inFlow, u.flow * BYTES_PER_GB, Math.floor(u.expTime / 1000));
  } else {
    if (!/^-?\d+$/.test(tunnel)) return { r: fail("隧道不存在") };
    const ut = db.getUserTunnelById(parseInt(tunnel, 10));
    if (!ut || ut.userId !== u.id) return { r: fail("隧道不存在") };
    value = fmt(ut.outFlow, ut.inFlow, ut.flow * BYTES_PER_GB, Math.floor(ut.expTime / 1000));
  }
  return { text: value, header: value };
}
