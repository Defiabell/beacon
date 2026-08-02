import { runDailyCollect } from "./collect/run";
import type { Env } from "./types";

export default {
  async fetch(): Promise<Response> {
    return new Response("beacon", { status: 200 });
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyCollect(env, new Date(event.scheduledTime)).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;
