import { runDailyCollect } from "./collect/run";
import type { SourceName } from "./collect/run";
import type { Env } from "./types";
import { handleAdmin } from "./api/admin";
import { handlePublicApi, buildOverview, buildProjectDetail, buildMatrix, buildPostsWithMetrics } from "./api/public";
import { listTodos } from "./db";
import { renderOverview, renderProject, renderMatrix, renderTodos, renderPosts } from "./ui/pages";

const HTML_CACHE_CONTROL = "public, max-age=60, s-maxage=600";

function htmlOk(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": HTML_CACHE_CONTROL }
  });
}

function notFound(): Response {
  return new Response("404 not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function serverError(): Response {
  // Deliberately no error detail/stack trace in the body — this is the
  // client-facing page, not a log. The real error is left for the caller to
  // log via console.error before this is returned.
  return new Response(`<!doctype html><meta charset="utf-8"><title>beacon · 错误</title><p>服务暂时不可用，请稍后重试。</p>`, {
    status: 500,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

const PROJECT_PAGE_PATH = /^\/p\/([^/]+)$/;

// Decodes a %-encoded project-name path segment, mapping malformed encoding
// (e.g. "%zz", which makes decodeURIComponent throw) to null rather than
// letting the throw escape — same contract as handlePublicApi's
// /api/project/:name route, so an unknown-but-malformed name 404s instead of
// 500ing.
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// SSR page routes only respond to GET; anything else (and anything
// unmatched) falls through to the 404 at the bottom, same as `/nope`.
async function routePage(req: Request, env: Env, path: string): Promise<Response | null> {
  if (req.method !== "GET") return null;

  if (path === "/") return htmlOk(renderOverview(await buildOverview(env)));

  const projectMatch = path.match(PROJECT_PAGE_PATH);
  if (projectMatch) {
    const name = decodeSegment(projectMatch[1]);
    if (name === null) return notFound();
    const detail = await buildProjectDetail(env, name);
    if (!detail) return notFound();
    return htmlOk(renderProject(name, detail));
  }

  if (path === "/matrix") return htmlOk(renderMatrix(await buildMatrix(env)));

  if (path === "/todos") {
    const [open, done] = await Promise.all([listTodos(env.DB, "open"), listTodos(env.DB, "done")]);
    return htmlOk(renderTodos([...open, ...done]));
  }

  if (path === "/posts") return htmlOk(renderPosts(await buildPostsWithMetrics(env)));

  return null;
}

// Cron trigger for the split-off audit invocation (see wrangler.toml). Any
// other scheduled invocation (currently just "0 1 * * *") runs the cheap
// three; this keeps each invocation's subrequest count under the free-tier
// 50-per-invocation cap (see src/audit/run.ts's MAX_LINKS_CHECKED comment).
const AUDIT_ONLY_CRON = "30 1 * * *";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(req.url).pathname;

      // Edge caching via the Cache API: only for GET on public paths — never
      // /api/admin/* (writes, and reads would leak nothing public anyway but
      // the prefix is excluded on principle) and never a non-2xx response.
      // On workers.dev this API is inert (every request still runs the full
      // handler below); on a custom domain it gives true edge caching, so a
      // repeat hit within the Cache-Control window skips D1 entirely. The
      // browser-facing `max-age=60` (HTML_CACHE_CONTROL / public.ts's
      // CACHE_CONTROL) applies either way, independent of whether the edge
      // cache itself is active.
      const cacheable = req.method === "GET" && !path.startsWith("/api/admin/");
      if (cacheable) {
        const cached = await caches.default.match(req);
        if (cached) return cached;
      }

      let res: Response;
      // `await` here is load-bearing, not stylistic: without it, a rejection
      // inside handleAdmin (e.g. a D1 UNIQUE-constraint error) propagates as
      // an unhandled rejection on the promise this `return` merely forwards,
      // bypassing the surrounding try/catch entirely instead of being caught
      // by it — the catch below only intercepts synchronous throws and
      // rejections surfaced via `await`.
      if (path.startsWith("/api/admin/")) res = await handleAdmin(req, env, path);
      else if (path.startsWith("/api/")) res = (await handlePublicApi(req, env, path)) ?? notFound();
      else res = (await routePage(req, env, path)) ?? notFound();

      if (cacheable && res.status === 200) {
        ctx.waitUntil(caches.default.put(req, res.clone()));
      }
      return res;
    } catch (e) {
      console.error("beacon: unhandled error", e);
      return serverError();
    }
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const sources: SourceName[] = event.cron === AUDIT_ONLY_CRON ? ["audit"] : ["github", "posts", "goatcounter"];
    ctx.waitUntil(runDailyCollect(env, new Date(event.scheduledTime), undefined, sources).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;
