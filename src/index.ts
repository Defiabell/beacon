import { runDailyCollect } from "./collect/run";
import { scheduledCollection } from "./schedule";
import type { Env } from "./types";
import { handleAdmin } from "./api/admin";
import { handleUi } from "./api/ui";
import { handleSession } from "./api/session";
import { handlePublicApi, buildOverview, buildProjectDetail, buildMatrix, buildPostsWithMetrics, buildImpact } from "./api/public";
import { listTodos } from "./db";
import { renderOverview, renderProject, renderMatrix, renderTodos, renderPosts, renderImpact, renderTrends, renderSite } from "./ui/pages";
import { buildTrends, buildSiteDetail, parseTrendWindow } from "./api/trends";
import { handleWellKnown } from "./api/wellknown";
import { isAuthed, hasAdminCredential } from "./auth";
import { CONFIG } from "./config";
import { withHeadMeta } from "./ui/layout";

const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=600";
// CRITICAL: an authenticated page renders extra write controls (see
// src/ui/pages.ts's `authed` parameter) that must never reach an anonymous
// visitor. This Cache-Control is what a cookie-carrying request gets instead
// of PUBLIC_CACHE_CONTROL — see fetch()'s cacheablePathAndMethod/adminCredentialPresent
// handling below for the other half (skipping the cache read/write entirely).
const PRIVATE_CACHE_CONTROL = "private, no-store";

function htmlOk(body: string, cacheControl: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl }
  });
}

// One line per view for search results and link previews. Kept here with the
// routes so a new page cannot be added without deciding what it says.
const PAGE_DESCRIPTIONS: Record<string, string> = {
  "/": "beacon 记录一组个人项目每天的 GitHub star、仓库流量、网站访问和来源，并列出本周该做的曝光动作。",
  "/trends": "网站浏览、仓库流量、star 和服务请求的逐日图表，可切换近 7、30、90 天。",
  "/matrix": "项目与发布渠道的覆盖矩阵：哪些已经发过、每个渠道实测带来多少访问、下一步发哪里。",
  "/todos": "曝光体检生成的待办：每个仓库缺的描述、标签、截图、分享图等，修好后自动关闭。",
  "/posts": "已登记的帖子，以及它们每天的回复数和浏览数。",
  "/impact": "每一次发帖和每一条做完的待办，对照前后 7 天的流量变化与来源归因。"
};

function seoHtml(req: Request, path: string, description: string, body: string, cacheControl: string): Response {
  const origin = CONFIG.canonicalOrigin ?? new URL(req.url).origin;
  return htmlOk(
    withHeadMeta(body, { origin, path, description, siteName: "beacon", ogImage: CONFIG.ogImage, website: path === "/" }),
    cacheControl
  );
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
const SITE_PAGE_PATH = /^\/s\/([^/]+)$/;

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

  const described = (body: string) => seoHtml(req, path, PAGE_DESCRIPTIONS[path], body, cacheControl);

  if (path === "/") return described(renderOverview(await buildOverview(env), authed));

  const projectMatch = path.match(PROJECT_PAGE_PATH);
  if (projectMatch) {
    const name = decodeSegment(projectMatch[1]);
    if (name === null) return notFound();
    const detail = await buildProjectDetail(env, name);
    if (!detail) return notFound();
    return seoHtml(req, path, `${name} 的 star 增长、仓库流量、访问来源、帖子表现和曝光体检结果。`, renderProject(name, detail, authed), cacheControl);
  }

  if (path === "/trends") {
    const days = parseTrendWindow(new URL(req.url).searchParams.get("days"));
    return described(renderTrends(await buildTrends(env, days), authed));
  }

  const siteMatch = path.match(SITE_PAGE_PATH);
  if (siteMatch) {
    const host = decodeSegment(siteMatch[1]);
    if (host === null) return notFound();
    const detail = await buildSiteDetail(env, host, parseTrendWindow(new URL(req.url).searchParams.get("days")));
    if (!detail) return notFound();
    return seoHtml(req, path, `${detail.host} 每天的页面浏览、访问数，以及访客从哪里来。`, renderSite(detail, authed), cacheControl);
  }

  if (path === "/matrix") return described(renderMatrix(await buildMatrix(env), authed));

  if (path === "/todos") {
    const url = new URL(req.url);
    const filter = url.searchParams.get("status") === "done" ? "done" : undefined;
    const [open, done] = await Promise.all([listTodos(env.DB, "open"), listTodos(env.DB, "done")]);
    return described(renderTodos([...open, ...done], authed, filter));
  }

  if (path === "/posts") return described(renderPosts(await buildPostsWithMetrics(env), authed));

  if (path === "/impact") return described(renderImpact(await buildImpact(env), authed));

  return null;
}

// Every collection group and audit shard has its own subrequest budget.

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
      else res = (await handleWellKnown(req, env, path)) ?? (await routePage(req, env, path)) ?? notFound();

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
    const { sources, auditShard } = scheduledCollection(event.cron, event.scheduledTime);
    ctx.waitUntil(
      runDailyCollect(env, new Date(event.scheduledTime), undefined, sources, auditShard).then(
        () => undefined
      )
    );
  }
} satisfies ExportedHandler<Env>;
