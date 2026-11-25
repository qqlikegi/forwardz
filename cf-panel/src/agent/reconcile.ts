import {
  type ChainTunnelRow,
  groupChains,
  type NodeRow,
  type PanelDB,
  serviceName,
  type TunnelRow,
  type UserTunnelRow,
} from "../db/queries";
import {
  type AgentMessenger,
  type AgentResult,
  chainData,
  chainServiceData,
  forwardServicesData,
  limiterData,
  okIf,
  resultOk,
  speedToMBps,
} from "./commands";

export interface NodeState {
  limiters: Map<string, Record<string, unknown>>;
  chains: Map<string, Record<string, unknown>>;
  services: Map<string, Record<string, unknown>>;
  paused: Map<string, boolean>;
}

export function newNodeState(): NodeState {
  return {
    limiters: new Map(),
    chains: new Map(),
    services: new Map(),
    paused: new Map(),
  };
}

export function desiredStates(db: PanelDB, nodeIds: number[] | null): Map<number, NodeState> {
  const nodes = new Map<number, NodeRow>();
  for (const n of db.listNodes()) {
    nodes.set(n.id, n);
  }
  const states = new Map<number, NodeState>();
  if (nodeIds === null) {
    for (const id of nodes.keys()) {
      states.set(id, newNodeState());
    }
  } else {
    for (const id of nodeIds) {
      states.set(id, newNodeState());
    }
  }

  const tunnels = new Map<number, TunnelRow>();
  for (const t of db.listTunnels()) {
    tunnels.set(t.id, t);
  }

  const chainsByTunnel = new Map<number, ChainTunnelRow[]>();
  for (const ct of db.listChains("ORDER BY id")) {
    const arr = chainsByTunnel.get(ct.tunnelId) ?? [];
    arr.push(ct);
    chainsByTunnel.set(ct.tunnelId, arr);
  }

  const allExist = (list: ChainTunnelRow[]): boolean =>
    list.length > 0 && list.every((ct) => nodes.has(ct.nodeId));

  // 1. 隧道转发链 & 监听服务
  for (const [tid, chains] of chainsByTunnel.entries()) {
    const t = tunnels.get(tid);
    if (!t || t.type !== 2) continue;
    const { inNodes, hops, outNodes } = groupChains(chains);
    if (!allExist(outNodes)) continue;
    const nextOf = (i: number): ChainTunnelRow[] =>
      i + 1 < hops.length ? hops[i + 1] : outNodes;

    for (const ct of inNodes) {
      const s = states.get(ct.nodeId);
      const next = nextOf(-1);
      if (s && nodes.has(ct.nodeId) && allExist(next)) {
        const d = chainData(ct.nodeId, next, nodes);
        s.chains.set(String(d.name), d);
      }
    }
    for (let i = 0; i < hops.length; i++) {
      for (const ct of hops[i]) {
        const s = states.get(ct.nodeId);
        if (!s || !nodes.has(ct.nodeId)) continue;
        const next = nextOf(i);
        if (allExist(next)) {
          const d = chainData(ct.nodeId, next, nodes);
          s.chains.set(String(d.name), d);
        }
        const svc = chainServiceData(ct.nodeId, ct, nodes);
        s.services.set(String(svc.name), svc);
      }
    }
    for (const ct of outNodes) {
      const s = states.get(ct.nodeId);
      if (s) {
        const svc = chainServiceData(ct.nodeId, ct, nodes);
        s.services.set(String(svc.name), svc);
      }
    }
  }

  // 2. 限速器
  for (const sp of db.listSpeedLimits()) {
    const chains = chainsByTunnel.get(sp.tunnelId) ?? [];
    for (const ct of chains) {
      const s = states.get(ct.nodeId);
      if (s && nodes.has(ct.nodeId)) {
        const d = limiterData(sp.id, speedToMBps(sp.speed));
        s.limiters.set(String(d.name), d);
      }
    }
  }

  // 3. 转发服务
  const utByKey = new Map<string, UserTunnelRow>();
  for (const ut of db.listUserTunnels()) {
    utByKey.set(`${ut.userId}:${ut.tunnelId}`, ut);
  }
  const portsByForward = new Map<number, Map<number, number>>();
  for (const fp of db.listForwardPorts()) {
    let m = portsByForward.get(fp.forwardId);
    if (!m) {
      m = new Map();
      portsByForward.set(fp.forwardId, m);
    }
    m.set(fp.nodeId, fp.port);
  }

  for (const f of db.listForwards()) {
    const t = tunnels.get(f.tunnelId);
    if (!t) continue;
    const ut = utByKey.get(`${f.userId}:${f.tunnelId}`) ?? null;
    const limiter = ut ? ut.speedId : null;
    const name = serviceName(f.id, f.userId, ut);
    const chains = chainsByTunnel.get(f.tunnelId) ?? [];
    for (const ct of chains) {
      if (ct.chainType !== 1) continue;
      const s = states.get(ct.nodeId);
      const node = nodes.get(ct.nodeId);
      const port = portsByForward.get(f.id)?.get(ct.nodeId);
      if (!s || !node || port === undefined) continue;
      for (const svc of forwardServicesData(name, limiter, node, f, port, t)) {
        const n = String(svc.name);
        s.services.set(n, svc);
        s.paused.set(n, f.status === 0);
      }
    }
  }

  return states;
}

export function stateFromReport(rawText: string): NodeState {
  const parsed = JSON.parse(rawText) as {
    limiters?: Record<string, unknown>[];
    chains?: Record<string, unknown>[];
    services?: Record<string, unknown>[];
  };
  const s = newNodeState();
  for (const m of parsed.limiters ?? []) {
    if (m && typeof m === "object") s.limiters.set(strVal(m.name), m);
  }
  for (const m of parsed.chains ?? []) {
    if (m && typeof m === "object") s.chains.set(strVal(m.name), m);
  }
  for (const m of parsed.services ?? []) {
    if (!m || typeof m !== "object") continue;
    const n = strVal(m.name);
    s.services.set(n, m);
    const md = m.metadata;
    if (md && typeof md === "object" && (md as Record<string, unknown>).paused === true) {
      s.paused.set(n, true);
    }
  }
  return s;
}

function strVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : String(v);
}

function subObj(m: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = m[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function objList(m: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const arr = m[key];
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
}

function serviceFP(m: Record<string, unknown>): string {
  const fwd = subObj(m, "forwarder");
  const targets = objList(fwd, "nodes").map((n) => strVal(n.addr));
  return [
    strVal(m.addr),
    strVal(m.limiter),
    strVal(subObj(m, "handler").type),
    strVal(subObj(m, "handler").chain),
    strVal(subObj(m, "listener").type),
    targets.join(","),
    strVal(subObj(fwd, "selector").strategy),
    strVal(subObj(m, "metadata").interface),
  ].join("|");
}

function chainFP(m: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const hop of objList(m, "hops")) {
    parts.push(`hop:${strVal(subObj(hop, "selector").strategy)}:${strVal(hop.interface)}`);
    for (const n of objList(hop, "nodes")) {
      parts.push(
        `${strVal(n.addr)}:${strVal(subObj(n, "dialer").type)}:${strVal(subObj(n, "connector").type)}`,
      );
    }
  }
  return parts.join("|");
}

function limiterFP(m: Record<string, unknown>): string {
  const arr = m.limits;
  if (!Array.isArray(arr)) return "";
  return arr.map(strVal).join(",");
}

const PANEL_SERVICE_RE = /^(\d+_\d+_\d+_(tcp|udp)|\d+_tls)$/;
const PANEL_CHAIN_RE = /^chains_\d+$/;
const PANEL_LIMITER_RE = /^\d+$/;

function sortedKeys<V>(m: Map<string, V>): string[] {
  return Array.from(m.keys()).sort();
}

export async function applyDiff(
  messenger: AgentMessenger,
  nodeId: number,
  have: NodeState,
  want: NodeState,
): Promise<string[]> {
  const errs: string[] = [];
  let changed = 0;
  const note = (action: string, name: string, r: AgentResult): boolean => {
    changed++;
    if (resultOk(r)) return true;
    errs.push(`${action} ${name}: ${r.msg}`);
    return false;
  };

  // 1. 限速器
  for (const name of sortedKeys(want.limiters)) {
    const d = want.limiters.get(name)!;
    const old = have.limiters.get(name);
    if (!old) {
      note("创建限速器", name, okIf(await messenger.sendMsg(nodeId, d, "AddLimiters"), "exists"));
    } else if (limiterFP(old) !== limiterFP(d)) {
      let r = await messenger.sendMsg(nodeId, { limiter: name, data: d }, "UpdateLimiters");
      if (r.msg.includes("not found")) {
        r = okIf(await messenger.sendMsg(nodeId, d, "AddLimiters"), "exists");
      }
      note("更新限速器", name, r);
    }
  }

  // 2. 转发链
  for (const name of sortedKeys(want.chains)) {
    const d = want.chains.get(name)!;
    const old = have.chains.get(name);
    if (!old) {
      note("创建转发链", name, okIf(await messenger.sendMsg(nodeId, d, "AddChains"), "exists"));
    } else if (chainFP(old) !== chainFP(d)) {
      let r = await messenger.sendMsg(nodeId, { chain: name, data: d }, "UpdateChains");
      if (r.msg.includes("not found")) {
        r = okIf(await messenger.sendMsg(nodeId, d, "AddChains"), "exists");
      }
      note("更新转发链", name, r);
    }
  }

  // 3. 服务
  for (const name of sortedKeys(want.services)) {
    const d = want.services.get(name)!;
    const old = have.services.get(name);
    let pushed = false;
    if (!old) {
      if (!note("创建服务", name, okIf(await messenger.sendMsg(nodeId, [d], "AddService"), "exists"))) {
        continue;
      }
      pushed = true;
    } else if (serviceFP(old) !== serviceFP(d)) {
      let r = await messenger.sendMsg(nodeId, [d], "UpdateService");
      if (r.msg.includes("not found")) {
        r = okIf(await messenger.sendMsg(nodeId, [d], "AddService"), "exists");
      }
      if (!note("更新服务", name, r)) continue;
      pushed = true;
    }
    const running = pushed || !have.paused.get(name);
    const wantPaused = !!want.paused.get(name);
    if (wantPaused && running) {
      note("暂停服务", name, await messenger.sendMsg(nodeId, { services: [name] }, "PauseService"));
    } else if (!wantPaused && !running) {
      note("恢复服务", name, await messenger.sendMsg(nodeId, { services: [name] }, "ResumeService"));
    }
  }

  // 4. 删除多余配置：服务 -> 转发链 -> 限速器
  const extraSvc: string[] = [];
  for (const name of sortedKeys(have.services)) {
    if (!want.services.has(name) && PANEL_SERVICE_RE.test(name)) {
      extraSvc.push(name);
    }
  }
  if (extraSvc.length > 0) {
    note(
      "删除服务",
      extraSvc.join(","),
      okIf(await messenger.sendMsg(nodeId, { services: extraSvc }, "DeleteService"), "not found"),
    );
  }
  for (const name of sortedKeys(have.chains)) {
    if (!want.chains.has(name) && PANEL_CHAIN_RE.test(name)) {
      note(
        "删除转发链",
        name,
        okIf(await messenger.sendMsg(nodeId, { chain: name }, "DeleteChains"), "not found"),
      );
    }
  }
  for (const name of sortedKeys(have.limiters)) {
    if (!want.limiters.has(name) && PANEL_LIMITER_RE.test(name)) {
      note(
        "删除限速器",
        name,
        okIf(await messenger.sendMsg(nodeId, { limiter: name }, "DeleteLimiters"), "not found"),
      );
    }
  }

  if (changed > 0) {
    console.log(
      JSON.stringify({
        event: "reconcile",
        nodeId,
        changed,
        failed: errs.length,
      }),
    );
  }
  return errs;
}

export async function pushChanges(
  messenger: AgentMessenger,
  before: Map<number, NodeState>,
  after: Map<number, NodeState>,
): Promise<string[]> {
  const errs: string[] = [];
  const ids = Array.from(after.keys()).sort((a, b) => a - b);
  for (const id of ids) {
    if (!messenger.nodeOnline(id)) continue;
    const b = before.get(id) ?? newNodeState();
    const diffs = await applyDiff(messenger, id, b, after.get(id)!);
    for (const e of diffs) {
      errs.push(`节点${id} ${e}`);
    }
  }
  return errs;
}
