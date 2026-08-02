import { runDailyCollect } from "./collect/run";
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(req.url).pathname;

      // `await` here is load-bearing, not stylistic: without it, a rejection
      // inside handleAdmin (e.g. a D1 UNIQUE-constraint error) propagates as
      // an unhandled rejection on the promise this `return` merely forwards,
      // bypassing the surrounding try/catch entirely instead of being caught
      // by it — the catch below only intercepts synchronous throws and
      // rejections surfaced via `await`.
      if (path.startsWith("/api/admin/")) return await handleAdmin(req, env, path);
      if (path.startsWith("/api/")) return (await handlePublicApi(req, env, path)) ?? notFound();

      return (await routePage(req, env, path)) ?? notFound();
    } catch (e) {
      console.error("beacon: unhandled error", e);
      return serverError();
    }
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyCollect(env, new Date(event.scheduledTime)).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;
