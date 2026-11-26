import { PanelHub } from "./panel-hub";
import { localCalendarParts, parseTzOffsetMinutes } from "./utils/timezone";

export { PanelHub };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/system-info") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.PANEL_HUB.getByName("main");
      return stub.fetch(request);
    }
    if (p.startsWith("/api/") || p.startsWith("/flow/")) {
      const stub = env.PANEL_HUB.getByName("main");
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const stub = env.PANEL_HUB.getByName("main");
    const tzOffsetMin = parseTzOffsetMinutes(env.TZ_OFFSET_MINUTES);
    const localMin = localCalendarParts(controller.scheduledTime, tzOffsetMin).minute;

    // 统一使用单个 * * * * * Cron（仅占 Free Plan 账号 5 个 Cron 限额中的 1 个）：
    // - 间隔 ≥ 60 秒时直接按设定周期探测；间隔为 10–59 秒时由 DO alarm() 驱动，此 Cron 兼作守护重启
    // - 每个整点顺序执行整点流量统计，再检查 00:xx 每日流量重置与到期停用
    const tasks: Promise<unknown>[] = [stub.runTunnelLatencyProbe()];
    if (localMin === 0) {
      tasks.push(
        (async () => {
          await stub.runHourlyStats();
          await stub.runDailyReset(false);
        })(),
      );
    }
    ctx.waitUntil(Promise.allSettled(tasks));
  },
} satisfies ExportedHandler<Env>;
