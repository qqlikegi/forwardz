import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  aesDecrypt,
  aesEncrypt,
  decryptIfNeeded,
  encryptForNode,
  generateToken,
  parseToken,
} from "../src/crypto";
import { processServerAddress, speedToMBps } from "../src/utils/validation";

async function apiPost<T = any>(
  path: string,
  body: Record<string, unknown> = {},
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ code: number; msg: string; data: T }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token) headers.Authorization = token;
  const resp = await SELF.fetch(`https://panel.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return (await resp.json()) as { code: number; msg: string; data: T };
}

/** 模拟一个在线的 Go Agent，自动解密指令、记录收到的命令并按需回复 OK */
async function connectFakeAgent(
  secret: string,
  onCmd?: (cmd: { type: string; data: any; requestId?: string }) => {
    message?: string;
    type?: string;
    data?: unknown;
  } | null,
) {
  const resp = await SELF.fetch(
    `https://panel.test/system-info?type=1&secret=${secret}&version=1.02&http=0&tls=0&socks=0`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(resp.status).toBe(101);
  const ws = resp.webSocket!;
  ws.accept();

  const received: Array<{ type: string; data: any; requestId?: string; raw: string }> = [];
  const pongs: string[] = [];

  ws.addEventListener("message", (ev: MessageEvent) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    if (raw === "pong") {
      pongs.push(raw);
      return;
    }
    const plain = decryptIfNeeded(raw, secret);
    let parsed: any = null;
    try {
      parsed = JSON.parse(plain);
    } catch {
      return;
    }
    received.push({ ...parsed, raw: plain });
    if (parsed.requestId) {
      const custom = onCmd ? onCmd(parsed) : undefined;
      if (custom !== null) {
        const reply = {
          requestId: parsed.requestId,
          type: custom?.type ?? `${parsed.type}Response`,
          message: custom?.message ?? "OK",
          data: custom?.data,
        };
        ws.send(encryptForNode(secret, JSON.stringify(reply)));
      }
    }
  });

  return {
    ws,
    received,
    pongs,
    sendEncrypted(obj: unknown) {
      ws.send(encryptForNode(secret, JSON.stringify(obj)));
    },
    close() {
      ws.close(1000, "test done");
    },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Crypto & Utils", () => {
  it("encrypts and decrypts AES-256-GCM compatible with Go agent", () => {
    const secret = "node-secret-abc123";
    const plain = JSON.stringify({ type: "AddService", requestId: "req-1" });
    const enc = aesEncrypt(secret, plain);
    expect(aesDecrypt(secret, enc)).toBe(plain);

    const wrapped = encryptForNode(secret, plain);
    expect(decryptIfNeeded(wrapped, secret)).toBe(plain);
  });

  it("signs and verifies JWT tokens", () => {
    const jwtSecret = "super-secret-jwt-key-12345";
    const token = generateToken({ id: 1, user: "admin", roleId: 0 }, jwtSecret);
    const claims = parseToken(token, jwtSecret);
    expect(claims).toEqual({ userId: 1, roleId: 0, name: "admin" });
    expect(parseToken(token, "wrong-secret")).toBeNull();
  });

  it("formats IPv6 and HTTPS addresses without mangling URLs", () => {
    expect(processServerAddress("https://panel.example.com/")).toBe("https://panel.example.com");
    expect(processServerAddress("https://panel.example.com:8443")).toBe(
      "https://panel.example.com:8443",
    );
    expect(processServerAddress("2001:db8::1:6365")).toBe("[2001:db8::1]:6365");
    expect(speedToMBps(100)).toBe("12.5");
  });
});

describe("ForwardZ CF Panel End-to-End", () => {
  it("runs full lifecycle: setup, auth, nodes, WS telemetry, tunnel, forward, flow, cron, migrate", async () => {
    // 1. 首次部署状态 & 验证码默认关闭
    const s0 = await apiPost<{ needSetup: boolean }>("/api/v1/setup/status");
    expect(s0.code).toBe(0);
    expect(s0.data.needSetup).toBe(true);

    const cap = await apiPost<number>("/api/v1/captcha/check");
    expect(cap.code).toBe(0);
    expect(cap.data).toBe(0);

    // 2. 初始化管理员
    const init = await apiPost<{ token: string; name: string; role_id: number }>(
      "/api/v1/setup/init",
      { username: "rootadmin", password: "StrongPassword123" },
    );
    expect(init.code).toBe(0);
    expect(init.data.role_id).toBe(0);
    const adminToken = init.data.token;

    // 登录校验
    const badLogin = await apiPost("/api/v1/user/login", {
      username: "rootadmin",
      password: "wrong",
    });
    expect(badLogin.code).toBe(-1);

    const goodLogin = await apiPost<{ token: string }>("/api/v1/user/login", {
      username: "rootadmin",
      password: "StrongPassword123",
    });
    expect(goodLogin.code).toBe(0);

    // 未授权访问拦截
    const unauth = await apiPost("/api/v1/node/list");
    expect(unauth.code).toBe(401);

    // 3. 创建两个节点并获取其密钥
    expect(
      (
        await apiPost(
          "/api/v1/node/create",
          { name: "入口节点A", serverIp: "1.1.1.1", port: "10000-10020" },
          adminToken,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await apiPost(
          "/api/v1/node/create",
          { name: "出口节点B", serverIp: "2.2.2.2", port: "20000-20020" },
          adminToken,
        )
      ).code,
    ).toBe(0);

    const nodesRes = await apiPost<Array<{ id: number; name: string; status: number }>>(
      "/api/v1/node/list",
      {},
      adminToken,
    );
    expect(nodesRes.code).toBe(0);
    expect(nodesRes.data.length).toBe(2);
    const entryNodeId = nodesRes.data.find((n) => n.name === "入口节点A")!.id;
    const exitNodeId = nodesRes.data.find((n) => n.name === "出口节点B")!.id;

    // 从一键安装命令中提取 secret，同时验证默认使用当前 HTTPS 域名
    const installA = await apiPost<string>("/api/v1/node/install", { id: entryNodeId }, adminToken);
    const installB = await apiPost<string>("/api/v1/node/install", { id: exitNodeId }, adminToken);
    expect(installA.code).toBe(0);
    expect(installA.data).toContain("-a https://panel.test");
    const secretA = /-s (\S+)/.exec(installA.data)![1];
    const secretB = /-s (\S+)/.exec(installB.data)![1];

    // 4. 两个模拟 Agent 通过 WebSocket 连入，验证节能心跳 + 按需切换 2s 推送
    const agentA = await connectFakeAgent(secretA, (cmd) => {
      if (cmd.type === "TcpPing") {
        return {
          type: "TcpPingResponse",
          message: "OK",
          data: { success: true, averageTime: 18.5, packetLoss: 0 },
        };
      }
      return { message: "OK" };
    });
    const agentB = await connectFakeAgent(secretB, (cmd) => {
      if (cmd.type === "TcpPing") {
        return {
          type: "TcpPingResponse",
          message: "OK",
          data: { success: true, averageTime: 25.0, packetLoss: 0 },
        };
      }
      return { message: "OK" };
    });
    await sleep(50);

    // 验证平台自动响应 ping -> pong（不唤醒 DO）
    agentA.ws.send("ping");
    await sleep(30);
    expect(agentA.pongs).toContain("pong");
    expect(
      agentA.received.some((m) => m.type === "SetReportInterval" && m.data?.intervalSec === 0),
    ).toBe(true);

    // 管理员打开节点监控页连接 WS -> 节点应收到 SetReportInterval(2)
    const adminWsResp = await SELF.fetch(
      `https://panel.test/system-info?type=0&secret=${encodeURIComponent(adminToken)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(adminWsResp.status).toBe(101);
    const adminWs = adminWsResp.webSocket!;
    adminWs.accept();
    const adminMsgs: any[] = [];
    adminWs.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") adminMsgs.push(JSON.parse(ev.data));
    });
    await sleep(50);
    expect(
      agentA.received.some((m) => m.type === "SetReportInterval" && m.data?.intervalSec === 2),
    ).toBe(true);

    // 节点发送系统监控信息 -> 管理员实时收到
    agentA.sendEncrypted({
      uptime: 1234,
      cpu_usage: 12.5,
      memory_usage: 41.2,
      bytes_received: 1000,
      bytes_transmitted: 2000,
    });
    await sleep(50);
    expect(adminMsgs.some((m) => m.type === "info" && m.id === String(entryNodeId))).toBe(true);

    // 管理员关闭页面 -> 节点自动切回 intervalSec=0 节能模式
    adminWs.close(1000, "leave page");
    await sleep(50);
    expect(
      agentA.received.filter((m) => m.type === "SetReportInterval").at(-1)?.data?.intervalSec,
    ).toBe(0);

    // 5. 创建隧道转发（入口 -> 出口）
    const createTun = await apiPost(
      "/api/v1/tunnel/create",
      {
        name: "测试隧道1",
        type: 2,
        flow: 2,
        trafficRatio: 1,
        inNodeId: [{ nodeId: entryNodeId, chainType: 1 }],
        chainNodes: [],
        outNodeId: [{ nodeId: exitNodeId, chainType: 3, protocol: "tls", strategy: "round" }],
      },
      adminToken,
    );
    expect(createTun.code).toBe(0);
    expect(agentA.received.some((m) => m.type === "AddChains")).toBe(true);
    expect(agentB.received.some((m) => m.type === "AddService")).toBe(true);

    const tunList = await apiPost<Array<{ id: number }>>("/api/v1/tunnel/list", {}, adminToken);
    const tunnelId = tunList.data[0].id;

    // 并发隧道诊断
    const diag = await apiPost<{ results: Array<{ success: boolean; averageTime: number }> }>(
      "/api/v1/tunnel/diagnose",
      { tunnelId },
      adminToken,
    );
    expect(diag.code).toBe(0);
    expect(diag.data.results.length).toBeGreaterThanOrEqual(2);
    expect(diag.data.results.every((r) => r.success)).toBe(true);

    // 6. 创建普通用户、分配隧道（1 GB 配额）并创建转发
    const futureExp = Date.now() + 30 * 86_400_000;
    expect(
      (
        await apiPost(
          "/api/v1/user/create",
          {
            user: "alice",
            pwd: "alice-password",
            flow: 1,
            num: 5,
            expTime: futureExp,
            flowResetTime: 1,
          },
          adminToken,
        )
      ).code,
    ).toBe(0);

    const usersRes = await apiPost<Array<{ id: number; user: string }>>(
      "/api/v1/user/list",
      {},
      adminToken,
    );
    const aliceId = usersRes.data.find((u) => u.user === "alice")!.id;

    expect(
      (
        await apiPost(
          "/api/v1/tunnel/user/assign",
          {
            userId: aliceId,
            tunnelId,
            flow: 1,
            num: 5,
            flowResetTime: 1,
            expTime: futureExp,
          },
          adminToken,
        )
      ).code,
    ).toBe(0);

    const utList = await apiPost<Array<{ id: number }>>(
      "/api/v1/tunnel/user/list",
      { userId: aliceId },
      adminToken,
    );
    const userTunnelId = utList.data[0].id;

    const aliceLogin = await apiPost<{ token: string }>("/api/v1/user/login", {
      username: "alice",
      password: "alice-password",
    });
    expect(aliceLogin.code).toBe(0);
    const aliceToken = aliceLogin.data.token;

    // 普通用户创建转发
    const createFwd = await apiPost(
      "/api/v1/forward/create",
      {
        name: "测试转发1",
        tunnelId,
        remoteAddr: "8.8.8.8:443",
        strategy: "fifo",
      },
      aliceToken,
    );
    expect(createFwd).toMatchObject({ code: 0 });

    const fwList = await apiPost<Array<{ id: number; status: number }>>(
      "/api/v1/forward/list",
      {},
      aliceToken,
    );
    expect(fwList.data.length).toBe(1);
    const forwardId = fwList.data[0].id;

    // 7. 通过加密 WebSocket 上报超限流量（1 GB，双向 x2 = 2 GB）-> 自动暂停转发
    agentA.sendEncrypted({
      type: "FlowReport",
      data: [
        {
          n: `${forwardId}_${aliceId}_${userTunnelId}`,
          u: 600 * 1024 * 1024,
          d: 600 * 1024 * 1024,
        },
      ],
    });
    await sleep(100);

    expect(agentA.received.some((m) => m.type === "PauseService")).toBe(true);
    const fwAfter = await apiPost<Array<{ id: number; status: number; inFlow: number }>>(
      "/api/v1/forward/list",
      {},
      aliceToken,
    );
    expect(fwAfter.data[0].status).toBe(0);
    expect(fwAfter.data[0].inFlow).toBe(600 * 1024 * 1024 * 2);

    // 8. 触发整点统计 + 数据总览 + Sub-Store 订阅头
    const stub = env.PANEL_HUB.getByName("main");
    await stub.runHourlyStats();

    const overview = await apiPost<{
      nodeTotal: number;
      nodeOnline: number;
      totalUsedFlow: number;
      userCount: number;
    }>("/api/v1/dashboard/overview", {}, adminToken);
    expect(overview.code).toBe(0);
    expect(overview.data.nodeTotal).toBe(2);
    expect(overview.data.nodeOnline).toBe(2);
    expect(overview.data.userCount).toBe(1);
    expect(overview.data.totalUsedFlow).toBeGreaterThan(0);

    const subResp = await SELF.fetch(
      `https://panel.test/api/v1/open_api/sub_store?user=alice&pwd=alice-password`,
    );
    expect(subResp.status).toBe(200);
    expect(subResp.headers.get("subscription-userinfo")).toContain("total=1073741824");

    // 9. 验证换机自愈对账（/flow/config 上报空配置 -> 自动补发 AddChains/AddService）
    const beforeCount = agentA.received.length;
    const cfgResp = await SELF.fetch(
      `https://panel.test/flow/config?secret=${secretA}`,
      {
        method: "POST",
        body: encryptForNode(secretA, JSON.stringify({ limiters: [], chains: [], services: [] })),
      },
    );
    expect(await cfgResp.text()).toBe("ok");
    await sleep(100);
    const newCmds = agentA.received.slice(beforeCount).map((m) => m.type);
    expect(newCmds).toContain("AddChains");
    expect(newCmds).toContain("AddService");
    expect(newCmds).toContain("PauseService");

    agentA.close();
    agentB.close();
    await sleep(50);

    // 10. 验证受保护的分块 SQLite 迁移接口
    const denied = await apiPost("/api/v1/migrate/status", {}, undefined, {
      "X-Migration-Token": "wrong",
    });
    expect(denied.code).toBe(401);

    const migHeaders = { "X-Migration-Token": "test-migration-token-1234567890" };
    expect((await apiPost("/api/v1/migrate/reset", {}, undefined, migHeaders)).code).toBe(0);
    expect(
      (
        await apiPost(
          "/api/v1/migrate/batch",
          {
            table: "node",
            rows: [
              {
                id: 99,
                name: "旧VPS节点",
                secret: "old-secret-99",
                server_ip: "9.9.9.9",
                port: "1000-2000",
                created_time: 1700000000000,
                status: 1,
                http: 0,
                tls: 0,
                socks: 0,
                tcp_listen_addr: "[::]",
                udp_listen_addr: "[::]",
              },
            ],
          },
          undefined,
          migHeaders,
        )
      ).code,
    ).toBe(0);

    const fin = await apiPost<{ counts: Record<string, number> }>(
      "/api/v1/migrate/finalize",
      { sequences: { node: 99 }, panelAddr: "https://migrated.example.com" },
      undefined,
      migHeaders,
    );
    expect(fin.code).toBe(0);
    expect(fin.data.counts.node).toBe(1);
  });
});
