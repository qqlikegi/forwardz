import type { ChainTunnelRow, ForwardRow, NodeRow, TunnelRow } from "../db/queries";
import { processServerAddress, speedToMBps } from "../utils/validation";

export interface AgentResult {
  msg: string;
  data?: Record<string, unknown>;
}

export interface AgentMessenger {
  sendMsg(nodeId: number, data: unknown, typ: string): Promise<AgentResult>;
  nodeOnline(nodeId: number): boolean;
}

export function resultOk(r: AgentResult | null | undefined): boolean {
  return r != null && r.msg === "OK";
}

export function okIf(r: AgentResult, contains: string): AgentResult {
  if (r.msg.includes(contains)) {
    return { ...r, msg: "OK" };
  }
  return r;
}

export function nodeIface(n: NodeRow | undefined | null): string {
  return (n?.interfaceName ?? "").trim();
}

export function limiterData(name: number, speed: string): Record<string, unknown> {
  return {
    name: String(name),
    limits: [`$ ${speed}MB ${speed}MB`],
  };
}

export async function agentAddLimiter(
  m: AgentMessenger,
  nodeId: number,
  name: number,
  speed: string,
): Promise<AgentResult> {
  return okIf(await m.sendMsg(nodeId, limiterData(name, speed), "AddLimiters"), "exists");
}

export async function agentUpdateLimiter(
  m: AgentMessenger,
  nodeId: number,
  name: number,
  speed: string,
): Promise<AgentResult> {
  return m.sendMsg(
    nodeId,
    { limiter: String(name), data: limiterData(name, speed) },
    "UpdateLimiters",
  );
}

export async function agentDeleteLimiter(
  m: AgentMessenger,
  nodeId: number,
  name: number,
): Promise<AgentResult> {
  return okIf(await m.sendMsg(nodeId, { limiter: String(name) }, "DeleteLimiters"), "not found");
}

export function chainData(
  nodeId: number,
  next: ChainTunnelRow[],
  nodes: Map<number, NodeRow>,
): Record<string, unknown> {
  const hopNodes = next.map((ct) => {
    const n = nodes.get(ct.nodeId)!;
    return {
      name: `node_${ct.nodeId}`,
      addr: processServerAddress(`${n.serverIp}:${ct.port ?? 0}`),
      connector: { type: "relay" },
      dialer: { type: ct.protocol ?? "" },
    };
  });
  const first = next[0];
  const hop: Record<string, unknown> = {
    name: `hop_${first.tunnelId}`,
    selector: {
      strategy: first.strategy ?? "",
      maxFails: 1,
      failTimeout: 600_000_000_000, // 600s in nanoseconds
    },
    nodes: hopNodes,
  };
  const selfIface = nodeIface(nodes.get(nodeId));
  if (selfIface) {
    hop.interface = selfIface;
  }
  return {
    name: `chains_${first.tunnelId}`,
    hops: [hop],
  };
}

export async function agentAddChains(
  m: AgentMessenger,
  nodeId: number,
  next: ChainTunnelRow[],
  nodes: Map<number, NodeRow>,
): Promise<AgentResult> {
  return okIf(await m.sendMsg(nodeId, chainData(nodeId, next, nodes), "AddChains"), "exists");
}

export async function agentDeleteChains(
  m: AgentMessenger,
  nodeId: number,
  name: string,
): Promise<AgentResult> {
  return okIf(await m.sendMsg(nodeId, { chain: name }, "DeleteChains"), "not found");
}

export function chainServiceData(
  nodeId: number,
  ct: ChainTunnelRow,
  nodes: Map<number, NodeRow>,
): Record<string, unknown> {
  const n = nodes.get(ct.nodeId)!;
  const svc: Record<string, unknown> = {
    name: `${ct.tunnelId}_tls`,
    addr: `${n.tcpListenAddr}:${ct.port ?? 0}`,
    listener: { type: ct.protocol ?? "" },
  };
  const selfIface = nodeIface(nodes.get(nodeId));
  if (ct.chainType === 3 && selfIface) {
    svc.metadata = { interface: selfIface };
  }
  const handler: Record<string, unknown> = { type: "relay" };
  if (ct.chainType === 2) {
    handler.chain = `chains_${ct.tunnelId}`;
  }
  svc.handler = handler;
  return svc;
}

export async function agentAddChainService(
  m: AgentMessenger,
  nodeId: number,
  ct: ChainTunnelRow,
  nodes: Map<number, NodeRow>,
): Promise<AgentResult> {
  return okIf(
    await m.sendMsg(nodeId, [chainServiceData(nodeId, ct, nodes)], "AddService"),
    "exists",
  );
}

export function forwarderData(remoteAddr: string, strategy: string): Record<string, unknown> {
  const nodes = remoteAddr.split(",").map((addr, i) => ({
    name: `node_${i + 1}`,
    addr,
  }));
  return {
    nodes,
    selector: {
      strategy: strategy || "fifo",
      maxFails: 1,
      failTimeout: "600s",
    },
  };
}

export function forwardServicesData(
  name: string,
  limiter: number | null,
  node: NodeRow,
  f: ForwardRow,
  port: number,
  tunnel: TunnelRow,
): Record<string, unknown>[] {
  const services: Record<string, unknown>[] = [];
  for (const proto of ["tcp", "udp"] as const) {
    const listenAddr = proto === "udp" ? node.udpListenAddr : node.tcpListenAddr;
    const svc: Record<string, unknown> = {
      name: `${name}_${proto}`,
      addr: `${listenAddr}:${port}`,
    };
    const iface = nodeIface(node);
    if (tunnel.type === 1 && iface) {
      svc.metadata = { interface: iface };
    }
    if (limiter !== null) {
      svc.limiter = String(limiter);
    }
    const handler: Record<string, unknown> = { type: proto };
    if (tunnel.type === 2) {
      handler.chain = `chains_${f.tunnelId}`;
    }
    svc.handler = handler;
    const listener: Record<string, unknown> = { type: proto };
    if (proto === "udp") {
      listener.metadata = { keepAlive: true };
    }
    svc.listener = listener;
    svc.forwarder = forwarderData(f.remoteAddr, f.strategy);
    services.push(svc);
  }
  return services;
}

export async function agentAddOrUpdateService(
  m: AgentMessenger,
  name: string,
  limiter: number | null,
  node: NodeRow,
  f: ForwardRow,
  port: number,
  tunnel: TunnelRow,
  method: "AddService" | "UpdateService",
): Promise<AgentResult> {
  return okIf(
    await m.sendMsg(node.id, forwardServicesData(name, limiter, node, f, port, tunnel), method),
    "exists",
  );
}

export function forwardServiceNames(name: string): string[] {
  return [`${name}_tcp`, `${name}_udp`];
}

export async function agentDeleteService(
  m: AgentMessenger,
  nodeId: number,
  services: string[],
): Promise<AgentResult> {
  return okIf(await m.sendMsg(nodeId, { services }, "DeleteService"), "not found");
}

export async function agentPauseResume(
  m: AgentMessenger,
  nodeId: number,
  name: string,
  method: "PauseService" | "ResumeService",
): Promise<AgentResult> {
  return m.sendMsg(nodeId, { services: forwardServiceNames(name) }, method);
}

export { speedToMBps };
