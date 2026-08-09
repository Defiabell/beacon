// GET/POST /login and POST /logout — the cookie-based login flow described in
// the phase-1 plan. No JS: a plain password-field <form> POSTs here; a correct
// token sets the beacon_admin cookie and 303-redirects to "/"; a wrong one
// re-renders the same form with an error, at HTTP 401 (not a redirect — the
// error is shown directly in this response, per the design decision).
import type { Env } from "../types";
import { timingSafeEqual, adminCookieHeader, clearAdminCookieHeader } from "../auth";
import { renderLogin } from "../ui/pages";
import { parseForm, formString } from "../http-forms";

// Coordinator review (2026-08-10): a login page conventionally sends no-store
// (avoids a stale error/success state being served from a shared or browser
// cache). Paired with src/index.ts excluding /login from the cache-put path
// entirely — Cloudflare's Cache API rejects a .put() of a no-store response,
// which would otherwise reject the surrounding ctx.waitUntil on every single
// anonymous GET /login.
function htmlResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function seeOther(location: string, setCookie: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": setCookie } });
}

async function handleLoginSubmit(req: Request, env: Env): Promise<Response> {
  const form = await parseForm(req);
  const token = form ? formString(form, "token") : null;

  // Mirrors requireAdmin's own guards (src/auth.ts): never throw when
  // ADMIN_TOKEN is unset, and always use timingSafeEqual for the comparison.
  if (!env.ADMIN_TOKEN || !token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return htmlResponse(renderLogin(true), 401);
  }

  return seeOther("/", adminCookieHeader(token));
}

// Logging out is always a no-op-safe cookie clear + redirect, regardless of
// whether the caller was actually logged in — there's no reason to 401 a
// logout attempt just because the cookie was already missing or stale.
function handleLogout(): Response {
  return seeOther("/", clearAdminCookieHeader());
}

// `path` is the request's URL.pathname, matched together with req.method —
// mirrors handleAdmin/handleUi's contract. Returns null for anything
// unmatched so src/index.ts can fall through to its own 404.
export async function handleSession(req: Request, env: Env, path: string): Promise<Response | null> {
  const route = `${req.method} ${path}`;
  switch (route) {
    case "GET /login":
      return htmlResponse(renderLogin(false), 200);
    case "POST /login":
      return handleLoginSubmit(req, env);
    case "POST /logout":
      return handleLogout();
    default:
      return null;
  }
}
