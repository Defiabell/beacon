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

// Returns a 401 JSON Response when the request is not authorized, or null when
// it's fine to proceed. The token is only ever read from the Authorization
// header — never from the URL/query string — so it can't end up in access logs.
export function requireAdmin(req: Request, env: Env): Response | null {
  const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
  // A Worker deployed before `wrangler secret put ADMIN_TOKEN` has env.ADMIN_TOKEN
  // as `undefined` at runtime (despite the `Env` type saying `string`). Without
  // this guard, timingSafeEqual would immediately throw on `undefined.length`,
  // 500ing every admin request instead of cleanly 401ing them.
  if (!env.ADMIN_TOKEN) return unauthorized();

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith(BEARER_PREFIX) ? auth.slice(BEARER_PREFIX.length) : "";
  if (token.length === 0 || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return unauthorized();
  }
  return null;
}
