import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const ADMIN_TOKEN = "test-admin-token"; // bound in vitest.config.ts miniflare bindings

function formReq(path: string, fields: Record<string, string>): Request {
  return new Request(`https://beacon.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });
}

describe("GET /login", () => {
  it("renders the login form", async () => {
    const res = await SELF.fetch(new Request("https://beacon.internal/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain('<form method="post" action="/login"');
    expect(text).toContain('type="password"');
    expect(text).not.toContain("令牌错误");
  });

  // Coordinator review (2026-08-10): harmless as static content, but a login
  // page conventionally sends no-store — an anonymous GET /login was otherwise
  // eligible for the shared cache like any other public GET.
  it("sends Cache-Control: no-store", async () => {
    const res = await SELF.fetch(new Request("https://beacon.internal/login"));
    // Drain the body BEFORE asserting: this response is a 200 to a (today)
    // cacheable GET, so index.ts's fetch() has an outstanding
    // ctx.waitUntil(caches.default.put(req, res.clone())) racing this read. If
    // the assertion below throws first, neither tee branch of that clone ever
    // gets read and the test hangs forever (see test/router.test.ts's
    // file-level comment on this exact Miniflare/workerd behavior) — this bit
    // during RED while this test was still failing for the right reason.
    await res.text();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /login", () => {
  it("wrong token: re-renders the form with an error, HTTP 401, and sets no cookie", async () => {
    const res = await SELF.fetch(formReq("/login", { token: "wrong-token" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const text = await res.text();
    expect(text).toContain("令牌错误");
    expect(text).toContain('<form method="post" action="/login"');
  });

  it("missing token field: also 401s with the error form (never throws)", async () => {
    const res = await SELF.fetch(formReq("/login", {}));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("令牌错误");
  });

  it("correct token: 303s to / and sets the beacon_admin cookie with the required attributes", async () => {
    const res = await SELF.fetch(formReq("/login", { token: ADMIN_TOKEN }), { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`beacon_admin=${ADMIN_TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=7776000");
  });

  it("the cookie set on a successful login actually authenticates a subsequent request", async () => {
    const login = await SELF.fetch(formReq("/login", { token: ADMIN_TOKEN }), { redirect: "manual" });
    const setCookie = login.headers.get("Set-Cookie")!;
    const cookiePair = setCookie.split(";")[0]; // "beacon_admin=<token>"

    const res = await SELF.fetch(
      new Request("https://beacon.internal/todos", { headers: { Cookie: cookiePair } })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("登出"); // the authed-only header link
  });
});

describe("POST /logout", () => {
  it("303s to / and clears the beacon_admin cookie (Max-Age=0)", async () => {
    const res = await SELF.fetch(
      new Request("https://beacon.internal/logout", { method: "POST", headers: { Cookie: `beacon_admin=${ADMIN_TOKEN}` } }),
      { redirect: "manual" }
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("beacon_admin=;");
    expect(setCookie).toMatch(/Max-Age=0\b/);
  });

  it("is a harmless no-op (still 303s + clears) when there was no cookie to begin with", async () => {
    const res = await SELF.fetch(new Request("https://beacon.internal/logout", { method: "POST" }), { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0\b/);
  });

  it("GET /logout is not a valid route (only POST clears the cookie, no GET-based logout link)", async () => {
    const res = await SELF.fetch(new Request("https://beacon.internal/logout"));
    expect(res.status).toBe(404);
  });
});
