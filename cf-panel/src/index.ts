import { PanelHub } from "./panel-hub";

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
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(stub.runHourlyStats());
    } else if (controller.cron === "1 * * * *") {
      ctx.waitUntil(stub.runDailyReset(false));
    }
  },
} satisfies ExportedHandler<Env>;
