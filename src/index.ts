import { runDailyCollect } from "./collect/run";
import type { SourceName } from "./collect/run";
import type { Env } from "./types";
import { handleAdmin } from "./api/admin";
import { handleUi } from "./api/ui";
import { handleSession } from "./api/session";
import { handlePublicApi, buildOverview, buildProjectDetail, buildMatrix, buildPostsWithMetrics } from "./api/public";
import { listTodos } from "./db";
import { renderOverview, renderProject, renderMatrix, renderTodos, renderPosts } from "./ui/pages";
import { isAuthed, hasAdminCredential } from "./auth";

const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=600";
// CRITICAL: an authenticated page renders extra write controls (see
// src/ui/pages.ts's `authed` parameter) that must never reach an anonymous
// visitor. This Cache-Control is what a cookie-carrying request gets instead
// of PUBLIC_CACHE_CONTROL — see fetch()'s cacheablePathAndMethod/adminCookiePresent
// handling below for the other half (skipping the cache read/write entirely).
const PRIVATE_CACHE_CONTROL = "private, no-store";

function htmlOk(body: string, cacheControl: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl }
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

  const authed = isAuthed(req, env);
  const cacheControl = authed ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL;

  if (path === "/") return htmlOk(renderOverview(await buildOverview(env), authed), cacheControl);

  const projectMatch = path.match(PROJECT_PAGE_PATH);
  if (projectMatch) {
    const name = decodeSegment(projectMatch[1]);
    if (name === null) return notFound();
    const detail = await buildProjectDetail(env, name);
    if (!detail) return notFound();
    return htmlOk(renderProject(name, detail, authed), cacheControl);
  }

  if (path === "/matrix") return htmlOk(renderMatrix(await buildMatrix(env), authed), cacheControl);

  if (path === "/todos") {
    const url = new URL(req.url);
    const filter = url.searchParams.get("status") === "done" ? "done" : undefined;
    const [open, done] = await Promise.all([listTodos(env.DB, "open"), listTodos(env.DB, "done")]);
    return htmlOk(renderTodos([...open, ...done], authed, filter), cacheControl);
  }

  if (path === "/posts") return htmlOk(renderPosts(await buildPostsWithMetrics(env), authed), cacheControl);

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
      // /api/admin/* or /ui/* (writes, and reads would leak nothing public
      // anyway but the prefix is excluded on principle) and never a non-2xx
      // response. On workers.dev this API is inert (every request still runs
      // the full handler below); on a custom domain it gives true edge
      // caching, so a repeat hit within the Cache-Control window skips D1
      // entirely. The browser-facing `max-age=60` (PUBLIC_CACHE_CONTROL /
      // public.ts's CACHE_CONTROL) applies either way, independent of
      // whether the edge cache itself is active.
      //
      // CRITICAL: a request carrying an admin credential — the beacon_admin
      // cookie OR the Authorization header — must never have its response read
      // from or written to this shared cache. An authenticated page renders
      // extra controls that would otherwise leak to the next anonymous visitor
      // hitting the same URL (caches.default keys by URL, not by the Cookie or
      // Authorization header, since this app sets no Vary); the same gap
      // applies to a Bearer-authenticated GET (e.g. curl or a browser using the
      // header instead of the cookie) as to a cookie-authenticated one — both
      // render the same authed page. hasAdminCredential checks presence only
      // (not validity) deliberately — see its doc comment in src/auth.ts.
      const adminCredentialPresent = hasAdminCredential(req);
      // /login is also excluded here (not just /api/admin/* and /ui/*): its
      // response always carries Cache-Control: no-store (src/api/session.ts),
      // and Cloudflare's Cache API rejects a .put() of a no-store response —
      // feeding one in would reject the ctx.waitUntil below on every single
      // anonymous GET /login. /logout never reaches this branch anyway (it's
      // POST-only).
      const cacheablePathAndMethod =
        req.method === "GET" && !path.startsWith("/api/admin/") && !path.startsWith("/ui/") && path !== "/login";
      const cacheable = cacheablePathAndMethod && !adminCredentialPresent;

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
      else if (path.startsWith("/ui/")) res = await handleUi(req, env, path);
      else if (path === "/login" || path === "/logout") res = (await handleSession(req, env, path)) ?? notFound();
      else if (path.startsWith("/api/")) res = (await handlePublicApi(req, env, path)) ?? notFound();
      else res = (await routePage(req, env, path)) ?? notFound();

      // Exactly the paths that would otherwise have been publicly cacheable
      // get their Cache-Control overridden to private/no-store here when an
      // admin credential is present — /api/admin/* and /ui/* responses are
      // untouched (they already never carry a public Cache-Control at all).
      if (cacheablePathAndMethod && adminCredentialPresent) {
        res.headers.set("Cache-Control", PRIVATE_CACHE_CONTROL);
      }

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
