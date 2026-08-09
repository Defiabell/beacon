import { describe, it, expect } from "vitest";
import {
  hasAdminCookie,
  isAuthed,
  requireAdmin,
  adminCookieHeader,
  clearAdminCookieHeader,
  ADMIN_COOKIE_NAME
} from "../src/auth";
import type { Env } from "../src/types";

const ADMIN_TOKEN = "test-admin-token";
// Only ADMIN_TOKEN is read by the functions under test here (requireAdmin/isAuthed
// never touch DB/GITHUB_TOKEN), so a minimal cast is fine rather than pulling in
// the real `env` from cloudflare:test.
const baseEnv = { ADMIN_TOKEN } as Env;

function reqWithCookie(cookie: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers["Cookie"] = cookie;
  return new Request("https://beacon.internal/todos", { headers });
}

describe("hasAdminCookie", () => {
  it("returns true when the beacon_admin cookie is present, regardless of value", () => {
    expect(hasAdminCookie(reqWithCookie(`${ADMIN_COOKIE_NAME}=anything`))).toBe(true);
    expect(hasAdminCookie(reqWithCookie(`${ADMIN_COOKIE_NAME}=`))).toBe(true);
  });

  it("returns false when there is no Cookie header, or the cookie is absent from it", () => {
    expect(hasAdminCookie(reqWithCookie(null))).toBe(false);
    expect(hasAdminCookie(reqWithCookie("other=1"))).toBe(false);
  });

  it("finds the cookie among several, regardless of position", () => {
    expect(hasAdminCookie(reqWithCookie(`a=1; ${ADMIN_COOKIE_NAME}=tok; b=2`))).toBe(true);
  });
});

describe("requireAdmin: cookie support", () => {
  it("accepts a correct beacon_admin cookie with no Authorization header", () => {
    const req = reqWithCookie(`${ADMIN_COOKIE_NAME}=${ADMIN_TOKEN}`);
    expect(requireAdmin(req, baseEnv)).toBeNull();
  });

  it("401s a wrong cookie value", async () => {
    const req = reqWithCookie(`${ADMIN_COOKIE_NAME}=wrong-token`);
    const res = requireAdmin(req, baseEnv);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it("still accepts a valid Authorization header when no cookie is present (curl keeps working)", () => {
    const req = new Request("https://beacon.internal/todos", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(requireAdmin(req, baseEnv)).toBeNull();
  });

  it("accepts the cookie even when a wrong Authorization header is also present", () => {
    const req = new Request("https://beacon.internal/todos", {
      headers: { Authorization: "Bearer wrong", Cookie: `${ADMIN_COOKIE_NAME}=${ADMIN_TOKEN}` }
    });
    expect(requireAdmin(req, baseEnv)).toBeNull();
  });

  it("401s when env.ADMIN_TOKEN is unset, even with a cookie present", () => {
    const envWithoutToken = { ...baseEnv, ADMIN_TOKEN: undefined } as unknown as Env;
    const req = reqWithCookie(`${ADMIN_COOKIE_NAME}=anything`);
    expect(requireAdmin(req, envWithoutToken)?.status).toBe(401);
  });
});

describe("isAuthed", () => {
  it("true for a valid cookie, true for a valid header, false otherwise", () => {
    expect(isAuthed(reqWithCookie(`${ADMIN_COOKIE_NAME}=${ADMIN_TOKEN}`), baseEnv)).toBe(true);
    expect(isAuthed(new Request("https://beacon.internal/", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }), baseEnv)).toBe(true);
    expect(isAuthed(reqWithCookie(null), baseEnv)).toBe(false);
    expect(isAuthed(reqWithCookie(`${ADMIN_COOKIE_NAME}=wrong`), baseEnv)).toBe(false);
  });
});

describe("adminCookieHeader / clearAdminCookieHeader", () => {
  it("builds a Set-Cookie value with the required attributes and a ~90-day Max-Age", () => {
    const header = adminCookieHeader(ADMIN_TOKEN);
    expect(header).toContain(`${ADMIN_COOKIE_NAME}=${ADMIN_TOKEN}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=7776000");
  });

  it("clearAdminCookieHeader immediately expires the cookie", () => {
    const header = clearAdminCookieHeader();
    expect(header).toContain(`${ADMIN_COOKIE_NAME}=;`);
    expect(header).toMatch(/Max-Age=0\b/);
    expect(header).toContain("HttpOnly");
  });
});
