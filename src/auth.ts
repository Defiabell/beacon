import type { Env } from "./types";

// Constant-time-ish string comparison: always walks the full max(a.length, b.length)
// range (no early return on the first mismatching char, and no early return on a
// length mismatch either) so response timing doesn't leak how many leading
// characters of a guessed token were correct or whether the length was off.
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

const BEARER_PREFIX = "Bearer ";

export const ADMIN_COOKIE_NAME = "beacon_admin";
// ~90 days, per the design decision's literal Max-Age=7776000 (7776000 / 86400 = 90).
const COOKIE_MAX_AGE_SECONDS = 7776000;
const COOKIE_ATTRS = "HttpOnly; Secure; SameSite=Strict; Path=/";

// Builds the Set-Cookie value for a successful POST /login. The token itself is
// the cookie value — requireAdmin below compares it the same way it compares the
// Authorization header, via timingSafeEqual.
export function adminCookieHeader(token: string): string {
  return `${ADMIN_COOKIE_NAME}=${token}; ${COOKIE_ATTRS}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

// Builds the Set-Cookie value for POST /logout: same name/attributes, empty value,
// Max-Age=0 so the browser drops it immediately.
export function clearAdminCookieHeader(): string {
  return `${ADMIN_COOKIE_NAME}=; ${COOKIE_ATTRS}; Max-Age=0`;
}

// Reads a single named cookie out of the request's `Cookie` header. Returns null
// when the header is absent or doesn't contain that cookie. A plain split on ";"
// is enough here — the only cookie this app ever reads or writes is the fixed
// literal ADMIN_COOKIE_NAME, so full RFC 6265 grammar (quoted values, etc.) isn't
// needed.
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Whether the request's Cookie header carries the admin cookie at all — independent
// of whether its value actually validates. src/index.ts uses this (not requireAdmin)
// to decide cacheability: a request presenting *any* beacon_admin cookie must never
// have its response read from or written to the shared edge cache, even if the
// cookie turns out to be stale or wrong. Determining real validity would mean
// running the full timingSafeEqual check on every single request just to decide
// cacheability, and a merely-invalid-but-present cookie is still a strong enough
// signal that this is a privileged browser context that must not leak into (or
// read from) the public cache.
export function hasAdminCookie(req: Request): boolean {
  return readCookie(req, ADMIN_COOKIE_NAME) !== null;
}

// Returns a 401 JSON Response when the request is not authorized, or null when
// it's fine to proceed. Accepts either the `Authorization: Bearer` header (so
// existing curl-based/API usage keeps working) or the `beacon_admin` cookie (so
// the browser-based /ui/* forms and admin-authed page rendering work too) — either
// one, checked with the same timingSafeEqual comparison, is sufficient. The token
// itself is only ever read from the header or this one cookie — never from the
// URL/query string — so it can't end up in access logs.
export function requireAdmin(req: Request, env: Env): Response | null {
  const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
  // A Worker deployed before `wrangler secret put ADMIN_TOKEN` has env.ADMIN_TOKEN
  // as `undefined` at runtime (despite the `Env` type saying `string`). Without
  // this guard, timingSafeEqual would immediately throw on `undefined.length`,
  // 500ing every admin request instead of cleanly 401ing them.
  if (!env.ADMIN_TOKEN) return unauthorized();

  const auth = req.headers.get("Authorization") ?? "";
  const bearerToken = auth.startsWith(BEARER_PREFIX) ? auth.slice(BEARER_PREFIX.length) : "";
  if (bearerToken.length > 0 && timingSafeEqual(bearerToken, env.ADMIN_TOKEN)) return null;

  const cookieToken = readCookie(req, ADMIN_COOKIE_NAME) ?? "";
  if (cookieToken.length > 0 && timingSafeEqual(cookieToken, env.ADMIN_TOKEN)) return null;

  return unauthorized();
}

// Plain boolean form of requireAdmin, for the SSR page routes: they render
// successfully either way (anonymous degradation — see src/ui/pages.ts's `authed`
// parameter), unlike the hard-401 /api/admin/* and /ui/* routes, so they need a
// yes/no rather than a Response-or-null.
export function isAuthed(req: Request, env: Env): boolean {
  return requireAdmin(req, env) === null;
}
