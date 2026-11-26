import {
  agentAddChains,
  agentAddChainService,
  agentDeleteChains,
  agentDeleteService,
  type AgentMessenger,
  resultOk,
} from "../agent/commands";
import { desiredStates, pushChanges } from "../agent/reconcile";
import type { Claims } from "../crypto";
import {
  type ChainTunnelRow,
  type ForwardRow,
  groupChains,
  type NodeRow,
  type PanelDB,
  type TunnelRow,
} from "../db/queries";
import {
  fail,
  failCode,
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
  strPtr,
  throwBiz,
  throwValid,
  validRatio,
} from "../utils/validation";

export interface TunnelRouteDeps {
  db: PanelDB;
  messenger: AgentMessenger;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  deleteForwardInternal(f: ForwardRow): Promise<void>;
  syncForward(f: ForwardRow, inPort: number | null): Promise<string>;
}

function parseChainForm(raw: unknown, defaultType: number): ChainTunnelRow {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nodeId = parseNum(m.nodeId);
  const chainType = parseNum(m.chainType);
  const port = parseNum(m.port);
  const strategy = parseStr(m.strategy);
  const inx = parseNum(m.inx);
  const protocol = parseStr(m.protocol);
  return {
    id: null,
    tunnelId: 0,
    chainType: chainType.valid ? numInt(chainType) : defaultType,
    nodeId: numInt(nodeId),
    port: numPtr(port),
    strategy: strPtr(strategy),
    inx: numPtr(inx),
    protocol: strPtr(protocol),
  };
}

function nodePortForChain(
  db: PanelDB,
  nodeId: number,
  reserved: Map<number, Set<number>>,
): number {
  const node = db.getNode(nodeId);
  if (!node) throwBiz("节点不存在");
  const used = db.usedPorts(nodeId, 0);
  const res = reserved.get(nodeId);
  if (res) {
    for (const p of res) used.add(p);
  }
  for (const p of parsePorts(node.port)) {
    if (!used.has(p)) return p;
  }
  throwBiz("节点端口已满，无可用端口");
}

export async function handleTunnelCreate(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const name = parseStr(body.name);
  const type = parseNum(body.type);
  const flow = parseNum(body.flow);
  const inIpParam = parseStr(body.inIp);
  const trafficRatio = parseNum(body.trafficRatio);

  return deps.withLock(async () => {
    notBlank(name, "隧道名称不能为空");
    if (!Array.isArray(body.inNodeId)) {
      throwValid("入口节点不能为空");
    }
    notNull(type, "隧道类型不能为空");
    notNull(flow, "流量计算类型不能为空");
    validRatio(trafficRatio);

    if (deps.db.countOf("SELECT COUNT(*) FROM tunnel WHERE name = ?", name.v) > 0) {
      return fail("隧道名称重复");
    }
    const rawIn = body.inNodeId as unknown[];
    if (rawIn.length === 0) return fail("入口不能为空");
    const tunnelType = numInt(type);
    const rawOut = Array.isArray(body.outNodeId) ? (body.outNodeId as unknown[]) : [];
    const rawChainNodes = Array.isArray(body.chainNodes) ? (body.chainNodes as unknown[][]) : [];
    if (tunnelType === 2 && rawOut.length === 0) {
      return fail("出口不能为空");
    }

    const nodes = new Map<number, NodeRow>();
    const nodeIds: number[] = [];
    const loadNode = (id: number): boolean => {
      const n = deps.db.getNode(id);
      if (!n) return false;
      nodes.set(n.id, n);
      nodeIds.push(id);
      return true;
    };

    const inNodes: ChainTunnelRow[] = [];
    const hops: ChainTunnelRow[][] = [];
    const outNodes: ChainTunnelRow[] = [];

    for (const f of rawIn) {
      const ct = parseChainForm(f, 1);
      if (!loadNode(ct.nodeId)) return fail("节点不存在");
      inNodes.push(ct);
    }

    const reserved = new Map<number, Set<number>>();
    const assignPort = (ct: ChainTunnelRow) => {
      const p = nodePortForChain(deps.db, ct.nodeId, reserved);
      let s = reserved.get(ct.nodeId);
      if (!s) {
        s = new Set();
        reserved.set(ct.nodeId, s);
      }
      s.add(p);
      ct.port = p;
    };

    if (tunnelType === 2) {
      for (let i = 0; i < rawChainNodes.length; i++) {
        const hop = Array.isArray(rawChainNodes[i]) ? rawChainNodes[i] : [];
        const list: ChainTunnelRow[] = [];
        for (const f of hop) {
          const ct = parseChainForm(f, 2);
          if (!loadNode(ct.nodeId)) return fail("节点不存在");
          ct.inx = i + 1;
          assignPort(ct);
          list.push(ct);
        }
        hops.push(list);
      }
      for (const f of rawOut) {
        const ct = parseChainForm(f, 3);
        if (!loadNode(ct.nodeId)) return fail("节点不存在");
        assignPort(ct);
        outNodes.push(ct);
      }
    }

    const seen = new Set<number>();
    for (const id of nodeIds) {
      if (seen.has(id)) return fail("节点重复");
      seen.add(id);
    }
    for (const id of nodeIds) {
      if (nodes.get(id)!.status !== 1) return fail("部分节点不在线");
    }

    let inIP = inIpParam.v.trim();
    if (!inIpParam.valid || inIpParam.v === "") {
      inIP = inNodes.map((ct) => nodes.get(ct.nodeId)!.serverIp).join(",");
    } else {
      inIP = inIpParam.v;
    }
    const ratio = trafficRatio.valid ? trafficRatio.v : 1.0;
    const now = Date.now();
    deps.db.sql.exec(
      "INSERT INTO tunnel (name, traffic_ratio, type, flow, created_time, updated_time, status, in_ip) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      name.v,
      ratio,
      tunnelType,
      numInt(flow),
      now,
      now,
      inIP,
    );
    const tunnelId = deps.db.lastInsertId();

    const all = [...inNodes, ...hops.flat(), ...outNodes];
    for (const ct of all) {
      ct.tunnelId = tunnelId;
      deps.db.sql.exec(
        "INSERT INTO chain_tunnel (tunnel_id, chain_type, node_id, port, strategy, inx, protocol) VALUES (?, ?, ?, ?, ?, ?, ?)",
        tunnelId,
        String(ct.chainType),
        ct.nodeId,
        ct.port,
        ct.strategy,
        ct.inx,
        ct.protocol,
      );
      ct.id = deps.db.lastInsertId();
    }

    if (tunnelType !== 2) return ok();

    const chainOK: number[] = [];
    const serviceOK: number[] = [];
    const rollback = async (msg: string): Promise<R> => {
      for (const n of chainOK) {
        await agentDeleteChains(deps.messenger, n, `chains_${tunnelId}`);
      }
      for (const n of serviceOK) {
        await agentDeleteService(deps.messenger, n, [`${tunnelId}_tls`]);
      }
      deps.db.sql.exec("DELETE FROM chain_tunnel WHERE tunnel_id = ?", tunnelId);
      deps.db.sql.exec("DELETE FROM tunnel WHERE id = ?", tunnelId);
      return fail(msg);
    };

    for (const inn of inNodes) {
      const next = hops.length > 0 ? hops[0] : outNodes;
      const r = await agentAddChains(deps.messenger, inn.nodeId, next, nodes);
      if (!resultOk(r)) return rollback(r.msg);
      chainOK.push(inn.nodeId);
    }
    for (let i = 0; i < hops.length; i++) {
      const next = i + 1 < hops.length ? hops[i + 1] : outNodes;
      for (const ct of hops[i]) {
        const r1 = await agentAddChains(deps.messenger, ct.nodeId, next, nodes);
        if (!resultOk(r1)) return rollback(r1.msg);
        chainOK.push(ct.nodeId);
        const r2 = await agentAddChainService(deps.messenger, ct.nodeId, ct, nodes);
        if (!resultOk(r2)) return rollback(r2.msg);
        serviceOK.push(ct.nodeId);
      }
    }
    for (const out of outNodes) {
      const r = await agentAddChainService(deps.messenger, out.nodeId, out, nodes);
      if (!resultOk(r)) return rollback(r.msg);
      serviceOK.push(out.nodeId);
    }
    return ok();
  });
}

export function handleTunnelList(db: PanelDB): R {
  const tunnels = db.listTunnels();
  const byTunnel = new Map<number, ChainTunnelRow[]>();
  for (const ct of db.listChains("ORDER BY id")) {
    const arr = byTunnel.get(ct.tunnelId) ?? [];
    arr.push(ct);
    byTunnel.set(ct.tunnelId, arr);
  }
  const out = tunnels.map((t) => {
    const { inNodes, hops, outNodes } = groupChains(byTunnel.get(t.id) ?? []);
    return {
      id: t.id,
      name: t.name,
      type: t.type,
      flow: t.flow,
      trafficRatio: t.trafficRatio,
      status: t.status,
      createdTime: t.createdTime,
      updatedTime: t.updatedTime,
      inIp: t.inIp,
      inNodeId: inNodes,
      chainNodes: hops,
      outNodeId: outNodes,
    };
  });
  return ok(out);
}

export async function handleTunnelUpdate(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const idNum = parseNum(body.id);
  const name = parseStr(body.name);
  const typeNum = parseNum(body.type);
  const flowNum = parseNum(body.flow);
  const inIpParam = parseStr(body.inIp);
  const trafficRatio = parseNum(body.trafficRatio);

  notNull(idNum, "隧道ID不能为空");
  notBlank(name, "隧道名称不能为空");
  notNull(flowNum, "流量计算类型不能为空");
  validRatio(trafficRatio);

  return deps.withLock(async () => {
    const id = numInt(idNum);
    const t = deps.db.getTunnel(id);
    if (!t) return fail("隧道不存在");
    if (deps.db.countOf("SELECT COUNT(*) FROM tunnel WHERE name = ? AND id != ?", name.v, id) > 0) {
      return fail("隧道名称重复");
    }
    const oldChains = deps.db.listChains("WHERE tunnel_id = ? ORDER BY id", id);

    let tunnelType = t.type;
    let inNodes: ChainTunnelRow[] = [];
    let hops: ChainTunnelRow[][] = [];
    let outNodes: ChainTunnelRow[] = [];

    if (!Array.isArray(body.inNodeId)) {
      const g = groupChains(oldChains);
      inNodes = g.inNodes.map((c) => ({ ...c, id: null }));
      hops = g.hops.map((grp) => grp.map((c) => ({ ...c, id: null })));
      outNodes = g.outNodes.map((c) => ({ ...c, id: null }));
    } else {
      if (typeNum.valid) tunnelType = numInt(typeNum);
      if (tunnelType !== 1 && tunnelType !== 2) return fail("隧道类型错误");
      for (const f of body.inNodeId as unknown[]) {
        const ct = parseChainForm(f, 1);
        ct.chainType = 1;
        ct.port = null;
        ct.inx = null;
        inNodes.push(ct);
      }
      if (tunnelType === 2) {
        const rawHops = Array.isArray(body.chainNodes) ? (body.chainNodes as unknown[][]) : [];
        for (const group of rawHops) {
          if (!Array.isArray(group)) continue;
          const list: ChainTunnelRow[] = [];
          for (const f of group) {
            const ct = parseChainForm(f, 2);
            ct.chainType = 2;
            ct.port = null;
            ct.inx = hops.length + 1;
            list.push(ct);
          }
          if (list.length > 0) hops.push(list);
        }
        const rawOuts = Array.isArray(body.outNodeId) ? (body.outNodeId as unknown[]) : [];
        for (const f of rawOuts) {
          const ct = parseChainForm(f, 3);
          ct.chainType = 3;
          ct.port = null;
          ct.inx = null;
          outNodes.push(ct);
        }
      }
    }

    if (inNodes.length === 0) return fail("入口不能为空");
    if (tunnelType === 2 && outNodes.length === 0) return fail("出口不能为空");
    const newChains = [...inNodes, ...hops.flat(), ...outNodes];

    const nodes = new Map<number, NodeRow>();
    const seen = new Set<number>();
    for (const ct of newChains) {
      if (seen.has(ct.nodeId)) return fail("节点重复：同一个节点在隧道中只能出现一次");
      seen.add(ct.nodeId);
      const n = deps.db.getNode(ct.nodeId);
      if (!n) return fail("节点不存在");
      nodes.set(n.id, n);
    }

    // 端口规划
    const oldHeld = new Map<number, Set<number>>();
    const oldPort = new Map<number, number>();
    for (const ct of oldChains) {
      if (ct.port !== null && ct.chainType !== 1) {
        let s = oldHeld.get(ct.nodeId);
        if (!s) {
          s = new Set();
          oldHeld.set(ct.nodeId, s);
        }
        s.add(ct.port);
        oldPort.set(ct.nodeId, ct.port);
      }
    }

    const usedCache = new Map<number, Set<number>>();
    const rangeCache = new Map<number, number[]>();
    const inRange = new Map<number, Set<number>>();
    const prepare = (nid: number) => {
      if (usedCache.has(nid)) return;
      const u = deps.db.usedPorts(nid, 0);
      const held = oldHeld.get(nid);
      if (held) {
        for (const p of held) u.delete(p);
      }
      usedCache.set(nid, u);
      const r = parsePorts(nodes.get(nid)!.port);
      rangeCache.set(nid, r);
      inRange.set(nid, new Set(r));
    };
    const take = (nid: number, prefer: number): number | null => {
      prepare(nid);
      const u = usedCache.get(nid)!;
      if (prefer > 0 && inRange.get(nid)!.has(prefer) && !u.has(prefer)) {
        u.add(prefer);
        return prefer;
      }
      for (const p of rangeCache.get(nid)!) {
        if (!u.has(p)) {
          u.add(p);
          return p;
        }
      }
      return null;
    };

    for (const ct of newChains) {
      if (ct.chainType === 1) continue;
      const p = take(ct.nodeId, oldPort.get(ct.nodeId) ?? 0);
      if (p === null) return fail(`节点 ${nodes.get(ct.nodeId)!.name} 端口已满，无可用端口`);
      ct.port = p;
    }

    const entrySet = new Set(inNodes.map((ct) => ct.nodeId));
    const adds: { forwardId: number; nodeId: number; port: number }[] = [];
    const dels: number[] = [];
    const forwards = deps.db.listForwards("WHERE tunnel_id = ?", id);
    for (const f of forwards) {
      const fps = deps.db.listForwardPorts("WHERE forward_id = ? ORDER BY id", f.id);
      const have = new Set<number>();
      let prefer = 0;
      for (const fp of fps) {
        if (entrySet.has(fp.nodeId)) {
          have.add(fp.nodeId);
          if (prefer === 0) prefer = fp.port;
        } else {
          dels.push(fp.id);
        }
      }
      if (prefer === 0 && fps.length > 0) prefer = fps[0].port;
      for (const ct of inNodes) {
        if (have.has(ct.nodeId)) continue;
        const p = take(ct.nodeId, prefer);
        if (p === null) {
          return fail(
            `入口节点 ${nodes.get(ct.nodeId)!.name} 的空闲端口不够分配给隧道下已有的 ${forwards.length} 个转发`,
          );
        }
        adds.push({ forwardId: f.id, nodeId: ct.nodeId, port: p });
      }
    }

    const autoIP = inNodes.map((ct) => nodes.get(ct.nodeId)!.serverIp).join(",");
    const curInIp = t.inIp ?? "";
    const oldAuto = curInIp === "" || curInIp === deps.db.entryIPs(id);
    let inIP = inIpParam.v.trim();
    if (inIP === "" || (oldAuto && inIP === curInIp)) {
      inIP = autoIP;
    }

    const affectedSet = new Set<number>();
    for (const ct of oldChains) affectedSet.add(ct.nodeId);
    for (const ct of newChains) affectedSet.add(ct.nodeId);
    const affected = Array.from(affectedSet);
    const before = desiredStates(deps.db, affected);

    const sets = ["name = ?", "type = ?", "flow = ?", "in_ip = ?", "updated_time = ?"];
    const args: unknown[] = [name.v, tunnelType, numInt(flowNum), inIP, Date.now()];
    if (trafficRatio.valid) {
      sets.push("traffic_ratio = ?");
      args.push(trafficRatio.v);
    }
    args.push(id);

    deps.db.sql.exec(`UPDATE tunnel SET ${sets.join(", ")} WHERE id = ?`, ...args);
    deps.db.sql.exec("DELETE FROM chain_tunnel WHERE tunnel_id = ?", id);
    for (const ct of newChains) {
      deps.db.sql.exec(
        "INSERT INTO chain_tunnel (tunnel_id, chain_type, node_id, port, strategy, inx, protocol) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        String(ct.chainType),
        ct.nodeId,
        ct.port,
        ct.strategy,
        ct.inx,
        ct.protocol,
      );
    }
    for (const fpId of dels) {
      deps.db.sql.exec("DELETE FROM forward_port WHERE id = ?", fpId);
    }
    for (const a of adds) {
      deps.db.sql.exec(
        "INSERT INTO forward_port (forward_id, node_id, port) VALUES (?, ?, ?)",
        a.forwardId,
        a.nodeId,
        a.port,
      );
    }

    const errs = await pushChanges(deps.messenger, before, desiredStates(deps.db, affected));
    if (errs.length > 0) {
      return fail(
        `隧道已保存，但以下配置同步失败（节点重新连接后会自动重试）：${errs.join("；")}`,
      );
    }
    return ok();
  });
}

export async function deleteTunnelInternal(deps: TunnelRouteDeps, id: number): Promise<void> {
  if (!deps.db.getTunnel(id)) return;
  for (const f of deps.db.listForwards("WHERE tunnel_id = ?", id)) {
    await deps.deleteForwardInternal(f);
  }
  deps.db.sql.exec("DELETE FROM forward WHERE tunnel_id = ?", id);
  deps.db.sql.exec("DELETE FROM user_tunnel WHERE tunnel_id = ?", id);
  deps.db.sql.exec("DELETE FROM tunnel_latency WHERE tunnel_id = ?", id);
  deps.db.sql.exec("DELETE FROM tunnel WHERE id = ?", id);

  const chainName = `chains_${id}`;
  const svc = [`${id}_tls`];
  for (const ct of deps.db.listChains("WHERE tunnel_id = ?", id)) {
    if (ct.chainType === 1) {
      await agentDeleteChains(deps.messenger, ct.nodeId, chainName);
    } else if (ct.chainType === 2) {
      await agentDeleteChains(deps.messenger, ct.nodeId, chainName);
      await agentDeleteService(deps.messenger, ct.nodeId, svc);
    } else {
      await agentDeleteService(deps.messenger, ct.nodeId, svc);
    }
  }
  deps.db.sql.exec("DELETE FROM chain_tunnel WHERE tunnel_id = ?", id);
}

export async function handleTunnelDelete(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  return deps.withLock(async () => {
    if (!deps.db.getTunnel(id)) return fail("隧道不存在");
    await deleteTunnelInternal(deps, id);
    return ok();
  });
}

export function handleTunnelForUser(db: PanelDB, claims: Claims): R {
  if (claims.roleId === 0) {
    return ok(db.listTunnels("WHERE status = 1"));
  }
  return ok(
    db.listTunnels(
      "WHERE status = 1 AND id IN (SELECT tunnel_id FROM user_tunnel WHERE user_id = ?)",
      claims.userId,
    ),
  );
}

// ---------- 并发诊断（比原 Go 串行探测更快） ----------

export interface DiagResult {
  nodeId: number;
  nodeName: string;
  targetIp: string;
  targetPort: number;
  description: string;
  success: boolean;
  message: string;
  averageTime: number;
  packetLoss: number;
  timestamp: number;
  fromChainType: number | null;
  fromInx: number | null;
  toChainType: number | null;
  toInx: number | null;
}

export function tunnelTypeName(t: number): string {
  return t === 1 ? "端口转发" : "隧道转发";
}

export async function tcpPing(
  messenger: AgentMessenger,
  node: NodeRow,
  ip: string,
  port: number,
  desc: string,
): Promise<DiagResult> {
  const res: DiagResult = {
    nodeId: node.id,
    nodeName: node.name,
    targetIp: ip,
    targetPort: port,
    description: desc,
    success: false,
    message: "",
    averageTime: 0,
    packetLoss: 0,
    timestamp: Date.now(),
    fromChainType: null,
    fromInx: null,
    toChainType: null,
    toInx: null,
  };
  const r = await messenger.sendMsg(node.id, { ip, port, count: 4, timeout: 5000 }, "TcpPing");
  if (resultOk(r)) {
    if (r.data) {
      const success = r.data.success === true;
      res.success = success;
      if (success) {
        res.message = "TCP连接成功";
        res.averageTime = Number(r.data.averageTime ?? 0) || 0;
        res.packetLoss = Number(r.data.packetLoss ?? 0) || 0;
      } else {
        res.message = typeof r.data.errorMessage === "string" ? r.data.errorMessage : "连接失败";
        res.averageTime = -1;
        res.packetLoss = 100;
      }
    } else {
      res.success = true;
      res.message = "TCP连接成功";
    }
  } else {
    res.message = r.msg;
    res.averageTime = -1;
    res.packetLoss = 100;
  }
  return res;
}

export async function diagnoseChain(
  db: PanelDB,
  messenger: AgentMessenger,
  tunnel: TunnelRow,
  chains: ChainTunnelRow[],
  endpoints: (n: NodeRow, from: number) => Promise<DiagResult[]>,
): Promise<DiagResult[]> {
  const { inNodes, hops, outNodes } = groupChains(chains);
  if (tunnel.type === 1) {
    const groups = await Promise.all(
      inNodes.map(async (ct) => {
        const n = db.getNode(ct.nodeId);
        return n ? endpoints(n, 1) : [];
      }),
    );
    return groups.flat();
  }

  const tasks: Promise<DiagResult[]>[] = [];
  const link = (
    from: NodeRow,
    fromType: number,
    fromInx: number | null,
    to: ChainTunnelRow,
    toType: number,
    descPrefix: string,
  ) => {
    const toNode = db.getNode(to.nodeId);
    if (!toNode) return;
    tasks.push(
      tcpPing(messenger, from, toNode.serverIp, to.port ?? 0, `${descPrefix}(${toNode.name})`).then(
        (r) => [
          {
            ...r,
            fromChainType: fromType,
            fromInx,
            toChainType: toType,
            toInx: toType === 2 ? to.inx : null,
          },
        ],
      ),
    );
  };

  for (const ct of inNodes) {
    const from = db.getNode(ct.nodeId);
    if (!from) continue;
    if (hops.length > 0) {
      for (const to of hops[0]) link(from, 1, null, to, 2, `入口(${from.name})->第1跳`);
    } else {
      for (const to of outNodes) link(from, 1, null, to, 3, `入口(${from.name})->出口`);
    }
  }
  for (let i = 0; i < hops.length; i++) {
    for (const cur of hops[i]) {
      const from = db.getNode(cur.nodeId);
      if (!from) continue;
      if (i + 1 < hops.length) {
        for (const to of hops[i + 1]) {
          link(from, 2, cur.inx, to, 2, `第${i + 1}跳(${from.name})->第${i + 2}跳`);
        }
      } else {
        for (const to of outNodes) {
          link(from, 2, cur.inx, to, 3, `第${i + 1}跳(${from.name})->出口`);
        }
      }
    }
  }
  for (const ct of outNodes) {
    const n = db.getNode(ct.nodeId);
    if (n) tasks.push(endpoints(n, 3));
  }
  return (await Promise.all(tasks)).flat();
}

export async function handleTunnelDiagnose(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "tunnelId");
  const tunnel = deps.db.getTunnel(id);
  if (!tunnel) return fail("隧道不存在");
  const chains = deps.db.listChains("WHERE tunnel_id = ? ORDER BY id", id);
  if (chains.length === 0) return fail("隧道配置不完整");

  const results = await diagnoseChain(deps.db, deps.messenger, tunnel, chains, async (n, from) => {
    const label = from === 3 ? "出口" : "入口";
    const r = await tcpPing(deps.messenger, n, "www.google.com", 443, `${label}(${n.name})->外网`);
    r.fromChainType = from;
    return [r];
  });
  // 手动诊断时也顺手记录一条延迟样本（隧道转发只汇总内部链路跳点，不含外网 Google 检测）
  recordDiagnoseLatencySample(deps.db, tunnel, results);
  return ok({
    tunnelId: id,
    tunnelName: tunnel.name,
    tunnelType: tunnelTypeName(tunnel.type),
    results,
    timestamp: Date.now(),
  });
}

// ---------- 隧道 24h 延迟与丢包监控（每 15 分钟自动采集，支持手动立即探测） ----------

export interface TunnelLatencyPoint {
  t: number;
  ms: number;
  loss: number;
  ok: boolean;
}

export interface TunnelLatencySummary {
  tunnelId: number;
  minLatency: number | null;
  avgLatency: number | null;
  maxLatency: number | null;
  latestLatency: number | null;
  packetLoss: number | null;
  sampleCount: number;
  points: TunnelLatencyPoint[];
}

export const LATENCY_RETENTION_MS = 25 * 3600_000;
export const DEFAULT_LATENCY_PROBE_INTERVAL_MIN = 15;
export const LATENCY_PROBE_INTERVAL_KEY = "latency_probe_interval_min";
export const LATENCY_PROBE_LAST_KEY = "latency_probe_last_ms";

export function loadLatencyProbeIntervalMin(db: PanelDB): number {
  const raw = db.getSetting(LATENCY_PROBE_INTERVAL_KEY);
  if (raw === "") return DEFAULT_LATENCY_PROBE_INTERVAL_MIN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_LATENCY_PROBE_INTERVAL_MIN;
  if (n <= 0) return 0;
  return Math.max(5, Math.min(120, n));
}

export function handleLatencyPolicyGet(db: PanelDB): R {
  const intervalMin = loadLatencyProbeIntervalMin(db);
  const lastProbeTime = parseInt(db.getSetting(LATENCY_PROBE_LAST_KEY), 10) || 0;
  return ok({
    intervalMin,
    defaultIntervalMin: DEFAULT_LATENCY_PROBE_INTERVAL_MIN,
    lastProbeTime,
  });
}

export function handleLatencyPolicySave(db: PanelDB, body: Record<string, unknown>): R {
  const raw = parseNum(body.intervalMin);
  if (!raw.valid) return fail("请填写有效的探测间隔（分钟）");
  const n = numInt(raw);
  if (n !== 0 && (n < 5 || n > 120)) {
    return fail("探测间隔需为 0（关闭自动探测）或 5–120 分钟");
  }
  db.setSetting(LATENCY_PROBE_INTERVAL_KEY, String(n));
  const lastProbeTime = parseInt(db.getSetting(LATENCY_PROBE_LAST_KEY), 10) || 0;
  return ok({
    intervalMin: n,
    defaultIntervalMin: DEFAULT_LATENCY_PROBE_INTERVAL_MIN,
    lastProbeTime,
  });
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function clampLoss(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

function parseFirstRemoteTarget(remoteAddr: string): { host: string; port: number } | null {
  const first = (remoteAddr ?? "").split(",")[0]?.trim() ?? "";
  if (!first) return null;
  if (first.startsWith("[")) {
    const end = first.indexOf("]:");
    if (end <= 1) return null;
    const host = first.slice(1, end);
    const port = parseInt(first.slice(end + 2), 10);
    return host && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const idx = first.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = first.slice(0, idx).trim();
  const port = parseInt(first.slice(idx + 1).trim(), 10);
  return host && port > 0 && port <= 65535 ? { host, port } : null;
}

function saveLatencyRow(
  db: PanelDB,
  tunnelId: number,
  latency: number,
  packetLoss: number,
  success: boolean,
  nowMs = Date.now(),
): void {
  db.sql.exec(
    "INSERT INTO tunnel_latency (tunnel_id, latency, packet_loss, success, created_time) VALUES (?, ?, ?, ?, ?)",
    tunnelId,
    success ? round1(latency) : -1,
    round1(clampLoss(success ? packetLoss : 100)),
    success ? 1 : 0,
    nowMs,
  );
}

function recordDiagnoseLatencySample(db: PanelDB, tunnel: TunnelRow, results: DiagResult[]): void {
  const linkResults =
    tunnel.type === 2 ? results.filter((r) => r.toChainType !== null) : results;
  if (linkResults.length === 0) return;

  if (tunnel.type === 2) {
    // 按 (fromChainType, fromInx) 分阶段汇总，多跳延迟累加、丢包组合
    const stageMap = new Map<string, DiagResult[]>();
    for (const r of linkResults) {
      const k = `${r.fromChainType ?? 0}:${r.fromInx ?? 0}`;
      const arr = stageMap.get(k);
      if (arr) arr.push(r);
      else stageMap.set(k, [r]);
    }
    let totalMs = 0;
    let survival = 1;
    for (const stage of stageMap.values()) {
      const okLinks = stage.filter((r) => r.success && r.averageTime >= 0);
      if (okLinks.length === 0) {
        saveLatencyRow(db, tunnel.id, -1, 100, false);
        return;
      }
      totalMs += okLinks.reduce((s, r) => s + r.averageTime, 0) / okLinks.length;
      const stageLoss =
        stage.reduce((s, r) => s + (r.success ? clampLoss(r.packetLoss) : 100), 0) / stage.length;
      survival *= 1 - clampLoss(stageLoss) / 100;
    }
    saveLatencyRow(db, tunnel.id, totalMs, (1 - survival) * 100, true);
    return;
  }

  const okLinks = linkResults.filter((r) => r.success && r.averageTime >= 0);
  if (okLinks.length === 0) {
    saveLatencyRow(db, tunnel.id, -1, 100, false);
    return;
  }
  const avgMs = okLinks.reduce((s, r) => s + r.averageTime, 0) / okLinks.length;
  const avgLoss =
    linkResults.reduce((s, r) => s + (r.success ? clampLoss(r.packetLoss) : 100), 0) /
    linkResults.length;
  saveLatencyRow(db, tunnel.id, avgMs, avgLoss, true);
}

export interface QuickPingResult {
  ok: boolean;
  ms: number;
  loss: number;
}

export async function quickTcpPing(
  messenger: AgentMessenger,
  nodeId: number,
  ip: string,
  port: number,
): Promise<QuickPingResult> {
  if (!messenger.nodeOnline(nodeId)) {
    return { ok: false, ms: -1, loss: 100 };
  }
  const r = await messenger.sendMsg(nodeId, { ip, port, count: 3, timeout: 3000 }, "TcpPing");
  if (!resultOk(r) || !r.data) {
    return { ok: false, ms: -1, loss: 100 };
  }
  if (r.data.success !== true) {
    return { ok: false, ms: -1, loss: 100 };
  }
  const ms = Number(r.data.averageTime ?? 0);
  const loss = clampLoss(Number(r.data.packetLoss ?? 0));
  return { ok: Number.isFinite(ms) && ms >= 0, ms: Number.isFinite(ms) ? ms : 0, loss };
}

export async function probeTunnelLatency(
  db: PanelDB,
  messenger: AgentMessenger,
  tunnel: TunnelRow,
): Promise<boolean> {
  const chains = db.listChains("WHERE tunnel_id = ? ORDER BY id", tunnel.id);
  if (chains.length === 0) return false;
  const { inNodes, hops, outNodes } = groupChains(chains);
  if (inNodes.length === 0) return false;

  if (tunnel.type === 2) {
    const stages: ChainTunnelRow[][] = [inNodes, ...hops, outNodes].filter((s) => s.length > 0);
    if (stages.length < 2) return false;

    const stagePairs: Array<Array<{ fromNodeId: number; targetIp: string; targetPort: number }>> = [];
    for (let i = 0; i < stages.length - 1; i++) {
      const pairs: Array<{ fromNodeId: number; targetIp: string; targetPort: number }> = [];
      for (const fromCt of stages[i]) {
        for (const toCt of stages[i + 1]) {
          const toNode = db.getNode(toCt.nodeId);
          if (!toNode || !toCt.port) continue;
          pairs.push({ fromNodeId: fromCt.nodeId, targetIp: toNode.serverIp, targetPort: toCt.port });
        }
      }
      if (pairs.length === 0) {
        saveLatencyRow(db, tunnel.id, -1, 100, false);
        return true;
      }
      stagePairs.push(pairs);
    }

    const stageResults = await Promise.all(
      stagePairs.map((pairs) =>
        Promise.all(pairs.map((p) => quickTcpPing(messenger, p.fromNodeId, p.targetIp, p.targetPort))),
      ),
    );

    let totalMs = 0;
    let survival = 1;
    for (const resList of stageResults) {
      const okList = resList.filter((r) => r.ok);
      if (okList.length === 0) {
        saveLatencyRow(db, tunnel.id, -1, 100, false);
        return true;
      }
      totalMs += okList.reduce((s, r) => s + r.ms, 0) / okList.length;
      const stageLoss = resList.reduce((s, r) => s + r.loss, 0) / resList.length;
      survival *= 1 - clampLoss(stageLoss) / 100;
    }
    saveLatencyRow(db, tunnel.id, totalMs, (1 - survival) * 100, true);
    return true;
  }

  // 端口转发（type=1）：优先探测该隧道下首个启用转发的真实目标地址，无转发时使用 223.5.5.5:443 基线
  const fwds = db.listForwards("WHERE tunnel_id = ? ORDER BY status DESC, id ASC LIMIT 5", tunnel.id);
  let target: { host: string; port: number } | null = null;
  for (const f of fwds) {
    target = parseFirstRemoteTarget(f.remoteAddr);
    if (target) break;
  }
  if (!target) {
    target = { host: "223.5.5.5", port: 443 };
  }
  const results = await Promise.all(
    inNodes.map((ct) => quickTcpPing(messenger, ct.nodeId, target!.host, target!.port)),
  );
  const okList = results.filter((r) => r.ok);
  if (okList.length === 0) {
    saveLatencyRow(db, tunnel.id, -1, 100, false);
    return true;
  }
  const avgMs = okList.reduce((s, r) => s + r.ms, 0) / okList.length;
  const avgLoss = results.reduce((s, r) => s + r.loss, 0) / results.length;
  saveLatencyRow(db, tunnel.id, avgMs, avgLoss, true);
  return true;
}

export async function probeAllTunnelsLatency(
  db: PanelDB,
  messenger: AgentMessenger,
): Promise<number> {
  const cutoff = Date.now() - LATENCY_RETENTION_MS;
  db.sql.exec("DELETE FROM tunnel_latency WHERE created_time < ?", cutoff);
  const tunnels = db.listTunnels("WHERE status = 1 ORDER BY id ASC");
  if (tunnels.length === 0) return 0;
  const flags = await Promise.all(tunnels.map((t) => probeTunnelLatency(db, messenger, t)));
  return flags.filter(Boolean).length;
}

export function buildLatencyHistoryMap(
  db: PanelDB,
  hours = 24,
  tunnelId?: number,
  claims?: Claims,
): Record<string, TunnelLatencySummary> {
  const clampedHours = Math.max(1, Math.min(48, Math.trunc(hours) || 24));
  const since = Date.now() - clampedHours * 3600_000;
  let rows: Array<{
    tunnel_id: number;
    latency: number;
    packet_loss: number;
    success: number;
    created_time: number;
  }>;
  if (tunnelId !== undefined) {
    rows = db.sql
      .exec<{
        tunnel_id: number;
        latency: number;
        packet_loss: number;
        success: number;
        created_time: number;
      }>(
        "SELECT tunnel_id, latency, packet_loss, success, created_time FROM tunnel_latency WHERE tunnel_id = ? AND created_time >= ? ORDER BY created_time ASC",
        tunnelId,
        since,
      )
      .toArray();
  } else if (claims && claims.roleId !== 0) {
    rows = db.sql
      .exec<{
        tunnel_id: number;
        latency: number;
        packet_loss: number;
        success: number;
        created_time: number;
      }>(
        `SELECT tl.tunnel_id, tl.latency, tl.packet_loss, tl.success, tl.created_time
         FROM tunnel_latency tl
         INNER JOIN user_tunnel ut ON ut.tunnel_id = tl.tunnel_id
         WHERE ut.user_id = ? AND tl.created_time >= ?
         ORDER BY tl.tunnel_id ASC, tl.created_time ASC`,
        claims.userId,
        since,
      )
      .toArray();
  } else {
    rows = db.sql
      .exec<{
        tunnel_id: number;
        latency: number;
        packet_loss: number;
        success: number;
        created_time: number;
      }>(
        "SELECT tunnel_id, latency, packet_loss, success, created_time FROM tunnel_latency WHERE created_time >= ? ORDER BY tunnel_id ASC, created_time ASC",
        since,
      )
      .toArray();
  }

  const grouped = new Map<number, TunnelLatencyPoint[]>();
  for (const r of rows) {
    const tid = Number(r.tunnel_id);
    const okFlag = Number(r.success) === 1 && Number(r.latency) >= 0;
    const pt: TunnelLatencyPoint = {
      t: Number(r.created_time),
      ms: okFlag ? round1(Number(r.latency)) : -1,
      loss: okFlag ? round1(clampLoss(Number(r.packet_loss))) : 100,
      ok: okFlag,
    };
    const arr = grouped.get(tid);
    if (arr) arr.push(pt);
    else grouped.set(tid, [pt]);
  }

  const out: Record<string, TunnelLatencySummary> = {};
  for (const [tid, pts] of grouped.entries()) {
    const okPts = pts.filter((p) => p.ok);
    const minLatency = okPts.length ? round1(Math.min(...okPts.map((p) => p.ms))) : null;
    const maxLatency = okPts.length ? round1(Math.max(...okPts.map((p) => p.ms))) : null;
    const avgLatency = okPts.length
      ? round1(okPts.reduce((s, p) => s + p.ms, 0) / okPts.length)
      : null;
    const last = pts[pts.length - 1];
    const latestLatency = last && last.ok ? last.ms : null;
    const packetLoss = pts.length
      ? round1(pts.reduce((s, p) => s + p.loss, 0) / pts.length)
      : null;
    out[String(tid)] = {
      tunnelId: tid,
      minLatency,
      avgLatency,
      maxLatency,
      latestLatency,
      packetLoss,
      sampleCount: pts.length,
      points: pts,
    };
  }
  return out;
}

export function handleTunnelLatencyHistory(
  db: PanelDB,
  claims: Claims,
  body: Record<string, unknown>,
): R {
  const h = parseNum(body.hours);
  const hours = h.valid ? numInt(h) : 24;
  return ok(buildLatencyHistoryMap(db, hours, undefined, claims));
}

export async function handleTunnelProbeNow(
  db: PanelDB,
  messenger: AgentMessenger,
  claims: Claims,
  body: Record<string, unknown>,
): Promise<R> {
  const tidNum = parseNum(body.tunnelId);
  if (tidNum.valid && numInt(tidNum) > 0) {
    const tid = numInt(tidNum);
    if (claims.roleId !== 0 && !db.getUserTunnel(claims.userId, tid)) {
      return fail("隧道不存在");
    }
    const t = db.getTunnel(tid);
    if (!t) return fail("隧道不存在");
    await probeTunnelLatency(db, messenger, t);
    return ok(buildLatencyHistoryMap(db, 24, tid, claims));
  }
  if (claims.roleId !== 0) {
    return failCode(403, "权限不足，仅管理员可操作");
  }
  await probeAllTunnelsLatency(db, messenger);
  return ok(buildLatencyHistoryMap(db, 24, undefined, claims));
}

// ---------- 用户隧道权限 ----------

export function handleUserTunnelAssign(db: PanelDB, body: Record<string, unknown>): R {
  const userId = parseNum(body.userId);
  const tunnelId = parseNum(body.tunnelId);
  const flow = parseNum(body.flow);
  const num = parseNum(body.num);
  const flowResetTime = parseNum(body.flowResetTime);
  const expTime = parseNum(body.expTime);
  const speedId = parseNum(body.speedId);

  notNull(userId, "用户ID不能为空");
  notNull(tunnelId, "隧道ID不能为空");
  notNull(flow, "流量限制不能为空");
  minVal(flow, 0, "流量限制不能小于0");
  notNull(num, "转发数量不能为空");
  minVal(num, 0, "转发数量不能小于0");
  notNull(flowResetTime, "流量重置时间不能为空");
  notNull(expTime, "到期时间不能为空");

  if (
    db.countOf(
      "SELECT COUNT(*) FROM user_tunnel WHERE user_id = ? AND tunnel_id = ?",
      numInt(userId),
      numInt(tunnelId),
    ) > 0
  ) {
    return fail("该用户已拥有此隧道权限");
  }
  db.sql.exec(
    `INSERT INTO user_tunnel (user_id, tunnel_id, speed_id, num, flow, in_flow, out_flow, flow_reset_time, exp_time, status)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 1)`,
    numInt(userId),
    numInt(tunnelId),
    numPtr(speedId),
    numInt(num),
    numInt(flow),
    numInt(flowResetTime),
    numInt(expTime),
  );
  return ok();
}

export function handleUserTunnelList(db: PanelDB, body: Record<string, unknown>): R {
  const userId = parseNum(body.userId);
  if (!userId.valid) throwValid("不能为null");
  const rows = db.sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT ut.id, ut.user_id, ut.tunnel_id, ut.flow, ut.in_flow, ut.out_flow, ut.num,
              ut.flow_reset_time, ut.exp_time, ut.speed_id, ut.status,
              t.name AS tunnel_name, t.flow AS tunnel_flow, sl.name AS speed_name, sl.speed
       FROM user_tunnel ut
       LEFT JOIN tunnel t ON ut.tunnel_id = t.id
       LEFT JOIN speed_limit sl ON ut.speed_id = sl.id
       WHERE ut.user_id = ? ORDER BY ut.id`,
      numInt(userId),
    )
    .toArray();
  const list = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    tunnelId: r.tunnel_id,
    flow: r.flow,
    num: r.num,
    flowResetTime: r.flow_reset_time,
    expTime: r.exp_time,
    speedId: r.speed_id ?? null,
    speedLimitName: r.speed_name ?? null,
    speed: r.speed ?? null,
    tunnelName: r.tunnel_name ?? null,
    tunnelFlow: r.tunnel_flow ?? null,
    inFlow: r.in_flow,
    outFlow: r.out_flow,
    status: r.status,
  }));
  return ok(list);
}

export async function handleUserTunnelRemove(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  return deps.withLock(async () => {
    const ut = deps.db.getUserTunnelById(id);
    if (!ut) return fail("未找到对应的用户隧道权限记录");
    for (const f of deps.db.listForwards(
      "WHERE user_id = ? AND tunnel_id = ?",
      ut.userId,
      ut.tunnelId,
    )) {
      await deps.deleteForwardInternal(f);
    }
    deps.db.sql.exec("DELETE FROM user_tunnel WHERE id = ?", id);
    return ok();
  });
}

export async function handleUserTunnelUpdate(
  deps: TunnelRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = parseNum(body.id);
  const flow = parseNum(body.flow);
  const num = parseNum(body.num);
  const flowResetTime = parseNum(body.flowResetTime);
  const expTime = parseNum(body.expTime);
  const status = parseNum(body.status);
  const speedId = parseNum(body.speedId);

  notNull(id, "用户隧道权限ID不能为空");
  notNull(flow, "流量限制不能为空");
  minVal(flow, 0, "流量限制不能小于0");
  notNull(num, "转发数量不能为空");
  minVal(num, 0, "转发数量不能小于0");
  notNull(flowResetTime, "流量重置时间不能为空");
  notNull(expTime, "到期时间不能为空");
  notNull(status, "状态必选");

  const ut = deps.db.getUserTunnelById(numInt(id));
  if (!ut) return fail("隧道不存在");
  const newSpeed = numPtr(speedId);
  const speedChanged = ut.speedId !== newSpeed;

  deps.db.sql.exec(
    "UPDATE user_tunnel SET flow = ?, num = ?, flow_reset_time = ?, exp_time = ?, status = ?, speed_id = ? WHERE id = ?",
    numInt(flow),
    numInt(num),
    numInt(flowResetTime),
    numInt(expTime),
    numInt(status),
    newSpeed,
    ut.id,
  );

  if (!speedChanged) return ok();
  const failed: string[] = [];
  for (const f of deps.db.listForwards(
    "WHERE user_id = ? AND tunnel_id = ?",
    ut.userId,
    ut.tunnelId,
  )) {
    const msg = await deps.syncForward(f, null);
    if (msg) failed.push(`${f.name}：${msg}`);
  }
  if (failed.length > 0) {
    return fail(`权限已保存，但以下转发的限速同步失败：${failed.join("；")}`);
  }
  return ok();
}
