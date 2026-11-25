import type { AgentMessenger } from "../agent/commands";
import { desiredStates, pushChanges } from "../agent/reconcile";
import { newFingerprint, simpleUUID } from "../crypto";
import type { ChainTunnelRow, ForwardPortRow, PanelDB } from "../db/queries";
import { FINGERPRINT_KEY, FINGERPRINT_RE } from "../db/schema";
import {
  fail,
  notBlank,
  notNull,
  numInt,
  numPtr,
  ok,
  paramInt,
  paramStr,
  parseNum,
  parsePorts,
  parseStr,
  processServerAddress,
  type R,
  strPtr,
  throwBiz,
  validatePortRange,
} from "../utils/validation";

export interface NodeRouteDeps {
  db: PanelDB;
  messenger: AgentMessenger;
  releaseRepo: string;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  deleteTunnelInternal(tunnelId: number): Promise<void>;
}

export function handleNodeCreate(db: PanelDB, body: Record<string, unknown>): R {
  const name = parseStr(body.name);
  const serverIp = parseStr(body.serverIp);
  const port = parseStr(body.port);
  const interfaceName = parseStr(body.interfaceName);
  notBlank(name, "节点名称不能为空");
  notBlank(serverIp, "服务器ip不能为空");
  notBlank(port, "可用端口不能为空");
  validatePortRange(port.v);
  const now = Date.now();
  db.sql.exec(
    `INSERT INTO node (name, secret, server_ip, port, interface_name, created_time, updated_time, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    name.v,
    simpleUUID(),
    serverIp.v,
    port.v,
    strPtr(interfaceName),
    now,
    now,
  );
  return ok();
}

export function handleNodeList(db: PanelDB): R {
  const list = db.listNodes("ORDER BY status DESC").map((n) => ({ ...n, secret: null }));
  return ok(list);
}

function planPortMoves(
  db: PanelDB,
  nodeId: number,
  newRange: string,
): { chainMoves: Map<number, number>; portMoves: Map<number, number> } {
  const chainMoves = new Map<number, number>();
  const portMoves = new Map<number, number>();
  const ports = parsePorts(newRange);
  const allowed = new Set<number>(ports);
  const used = new Set<number>();
  const needChain: ChainTunnelRow[] = [];
  const needPort: ForwardPortRow[] = [];

  for (const ct of db.listChains("WHERE node_id = ? ORDER BY id", nodeId)) {
    if (ct.port === null) continue;
    if (allowed.has(ct.port)) {
      used.add(ct.port);
    } else if (ct.chainType !== 1) {
      needChain.push(ct);
    }
  }
  for (const fp of db.listForwardPorts("WHERE node_id = ? ORDER BY id", nodeId)) {
    if (allowed.has(fp.port)) {
      used.add(fp.port);
    } else {
      needPort.push(fp);
    }
  }

  const free = ports.filter((p) => !used.has(p));
  const need = needChain.length + needPort.length;
  if (need > free.length) {
    throwBiz(
      `新端口范围不够用：需要重新分配 ${need} 个端口（隧道 ${needChain.length} 个、转发 ${needPort.length} 个），新范围内只有 ${free.length} 个空闲端口`,
    );
  }
  let idx = 0;
  for (const ct of needChain) {
    if (ct.id !== null) chainMoves.set(ct.id, free[idx++]);
  }
  for (const fp of needPort) {
    portMoves.set(fp.id, free[idx++]);
  }
  return { chainMoves, portMoves };
}

export async function handleNodeUpdate(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = parseNum(body.id);
  const name = parseStr(body.name);
  const serverIp = parseStr(body.serverIp);
  const port = parseStr(body.port);
  const interfaceName = parseStr(body.interfaceName);
  const http = parseNum(body.http);
  const tls = parseNum(body.tls);
  const socks = parseNum(body.socks);
  const tcpListenAddr = parseStr(body.tcpListenAddr);
  const udpListenAddr = parseStr(body.udpListenAddr);

  notNull(id, "节点ID不能为空");
  notBlank(name, "节点名称不能为空");
  notBlank(serverIp, "服务器ip不能为空");
  notBlank(port, "可用port不能为空");
  validatePortRange(port.v);

  return deps.withLock(async () => {
    const node = deps.db.getNode(numInt(id));
    if (!node) return fail("节点不存在");

    const changed = (n: ReturnType<typeof parseNum>, cur: number) => n.valid && numInt(n) !== cur;
    if (
      node.status === 1 &&
      (changed(http, node.http) || changed(tls, node.tls) || changed(socks, node.socks))
    ) {
      const r = await deps.messenger.sendMsg(
        node.id,
        { http: numPtr(http), tls: numPtr(tls), socks: numPtr(socks) },
        "SetProtocol",
      );
      if (r.msg !== "OK") return fail(r.msg);
    }

    const related = deps.db.relatedNodeIds(node.id);
    const before = desiredStates(deps.db, related);
    const autoInIP = new Set<number>();
    for (const t of deps.db.tunnelsWithEntry(node.id)) {
      if (!t.inIp || t.inIp === deps.db.entryIPs(t.id)) {
        autoInIP.add(t.id);
      }
    }

    const { chainMoves, portMoves } = planPortMoves(deps.db, node.id, port.v);

    const tcp = tcpListenAddr.valid ? tcpListenAddr.v : "0.0.0.0";
    const udp = udpListenAddr.valid ? udpListenAddr.v : "0.0.0.0";
    const sets = [
      "name = ?",
      "server_ip = ?",
      "port = ?",
      "updated_time = ?",
      "tcp_listen_addr = ?",
      "udp_listen_addr = ?",
    ];
    const args: unknown[] = [name.v, serverIp.v, port.v, Date.now(), tcp, udp];
    for (const [col, v] of [
      ["http", http],
      ["tls", tls],
      ["socks", socks],
    ] as const) {
      if (v.valid) {
        sets.push(`${col} = ?`);
        args.push(numInt(v));
      }
    }
    if (interfaceName.valid) {
      sets.push("interface_name = ?");
      args.push(interfaceName.v);
    }
    args.push(node.id);
    deps.db.sql.exec(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...args);

    for (const [cid, p] of chainMoves.entries()) {
      deps.db.sql.exec("UPDATE chain_tunnel SET port = ? WHERE id = ?", p, cid);
    }
    for (const [fid, p] of portMoves.entries()) {
      deps.db.sql.exec("UPDATE forward_port SET port = ? WHERE id = ?", p, fid);
    }
    for (const tid of autoInIP) {
      deps.db.sql.exec("UPDATE tunnel SET in_ip = ? WHERE id = ?", deps.db.entryIPs(tid), tid);
    }

    const errs = await pushChanges(deps.messenger, before, desiredStates(deps.db, related));
    if (errs.length > 0) {
      return fail(
        `节点已保存，但以下配置同步失败（节点重新连接后会自动重试）：${errs.join("；")}`,
      );
    }
    return ok();
  });
}

export async function handleNodeDelete(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
): Promise<R> {
  const id = paramInt(body, "id");
  return deps.withLock(async () => {
    if (!deps.db.getNode(id)) return fail("节点不存在");
    const rows = deps.db.sql
      .exec<{ tunnel_id: number }>("SELECT DISTINCT tunnel_id FROM chain_tunnel WHERE node_id = ?", id)
      .toArray();
    for (const r of rows) {
      await deps.deleteTunnelInternal(Number(r.tunnel_id));
    }
    deps.db.sql.exec("DELETE FROM node WHERE id = ?", id);
    return ok();
  });
}

export function handleNodeInstall(
  deps: NodeRouteDeps,
  body: Record<string, unknown>,
  requestUrl: string,
): R {
  const id = paramInt(body, "id");
  const node = deps.db.getNode(id);
  if (!node) return fail("节点不存在");
  let ip = deps.db.getConfigValue("ip");
  if (!ip || ip.trim() === "") {
    // 若尚未手填面板地址，自动回落到当前访问的 CF Worker 域名，开箱即用
    try {
      ip = new URL(requestUrl).origin;
    } catch {
      return fail("请先前往「系统配置」设置面板地址");
    }
  }
  const cmd =
    `curl -L https://github.com/${deps.releaseRepo}/releases/latest/download/install.sh -o ./install.sh && ` +
    `chmod +x ./install.sh && ./install.sh -a ${processServerAddress(ip)} -s ${node.secret ?? ""} -f ${deps.db.panelFingerprint()}`;
  return ok(cmd);
}

// ---------- 网站配置 & 指纹 ----------

export function handleConfigList(db: PanelDB): R {
  const rows = db.sql.exec<{ name: string; value: string }>("SELECT name, value FROM vite_config").toArray();
  const m: Record<string, string> = {};
  for (const r of rows) m[r.name] = r.value;
  return ok(m);
}

export function handleConfigGet(db: PanelDB, body: Record<string, unknown>): R {
  const name = paramStr(body, "name").trim();
  if (!name) return fail("配置名称不能为空");
  const r = db.sql
    .exec<{ id: number; name: string; value: string; time: number }>(
      "SELECT id, name, value, time FROM vite_config WHERE name = ?",
      name,
    )
    .toArray()[0];
  if (!r) return fail("配置不存在");
  return ok(r);
}

export function handleConfigUpdate(db: PanelDB, body: Record<string, unknown>): R {
  const keys = Object.keys(body);
  if (keys.length === 0) return fail("配置数据不能为空");
  for (const k of keys) {
    if (!k.trim()) continue;
    const v = body[k] === null || body[k] === undefined ? "" : paramStr(body, k);
    db.upsertConfig(k, v);
  }
  return ok();
}

export function handleConfigUpdateSingle(db: PanelDB, body: Record<string, unknown>): R {
  const name = paramStr(body, "name").trim();
  const value = paramStr(body, "value");
  if (!name) return fail("配置名称不能为空");
  if (!value.trim()) return fail("配置值不能为空");
  db.upsertConfig(name, value);
  return ok();
}

export function handleFingerprintGet(db: PanelDB): R {
  return ok({ fingerprint: db.panelFingerprint() });
}

export function handleFingerprintSave(db: PanelDB, body: Record<string, unknown>): R {
  const fpStr = parseStr(body.fingerprint);
  const regenerate = Boolean(body.regenerate);
  let fp = fpStr.v.trim();
  if (regenerate) fp = newFingerprint();
  if (!FINGERPRINT_RE.test(fp)) {
    return fail("指纹必须是 8 位英文字母或数字");
  }
  db.setSetting(FINGERPRINT_KEY, fp);
  return ok({ fingerprint: fp });
}
