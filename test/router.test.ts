import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { CONFIG } from "../src/config";

const ADMIN_TOKEN = "test-admin-token"; // bound in vitest.config.ts miniflare bindings

function req(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown } = {}
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== null) headers["Authorization"] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`https://beacon.internal${path}`, init);
}

// I1: every cacheable 200 GET response now also gets `ctx.waitUntil(caches.default.put(request,
// response.clone()))` (src/index.ts). `.clone()` tees the response body; in this local
// Miniflare/workerd test runtime, if NEITHER tee branch is ever read, the cache-storage
// write's pending read() never resolves, the outstanding waitUntil never settles, and the
// test hangs forever (the test runner awaits outstanding waitUntil tasks before a request is
// considered done). In real production this isn't an issue — the platform itself always
// drains the returned response to send it to the client, which is what completes the tee on
// the other side — but a test that only asserts on status/headers must still explicitly read
// the body (even if it discards the result) to avoid this test-harness-only deadlock. Every
// `it()` below that expects a 200 from a cacheable GET does so.
describe("SSR pages", () => {
  it("GET / returns 200 text/html with the SSR cache headers and the overview marker", async () => {
    const res = await SELF.fetch(req("GET", "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=600");
    const text = await res.text();
    expect(text).toContain("本周建议行动");
  });

  it("GET /p/:name renders a known project's detail page", async () => {
    const name = CONFIG.projects[0].name;
    const res = await SELF.fetch(req("GET", `/p/${name}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain(name);
  });

  it("GET /p/unknown-project -> 404", async () => {
    const res = await SELF.fetch(req("GET", "/p/does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("GET /p/%zz (malformed percent-encoding) -> 404, not 500", async () => {
    const res = await SELF.fetch(req("GET", "/p/%zz"));
    expect(res.status).toBe(404);
  });

  it("GET /matrix -> 200 text/html", async () => {
    const res = await SELF.fetch(req("GET", "/matrix"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("渠道");
  });

  it("GET /todos -> 200 text/html", async () => {
    const res = await SELF.fetch(req("GET", "/todos"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    await res.text(); // drain the body — see the file-level comment on the cache-put tee
  });

  it("GET /posts -> 200 text/html", async () => {
    const res = await SELF.fetch(req("GET", "/posts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    await res.text(); // drain the body — see the file-level comment on the cache-put tee
  });
});

describe("edge cache (Cache API)", () => {
  // I1: on workers.dev the Cache API is inert (every request re-runs the
  // handler), but the code path must still execute without error and return
  // the right content either way — this is what's actually observable from a
  // test running against the local Miniflare/workerd runtime.
  it("a cacheable GET path (/matrix) returns the correct 200 HTML body across repeated requests", async () => {
    const first = await SELF.fetch(req("GET", "/matrix"));
    const second = await SELF.fetch(req("GET", "/matrix"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstText = await first.text();
    const secondText = await second.text();
    expect(firstText).toBe(secondText);
    expect(secondText).toContain("渠道");
  });

  // Non-GET and /api/admin/* must bypass the cache branch entirely (never
  // read from or written to caches.default) — since neither ever produces a
  // legitimate 200 (POST/PUT-only, auth-gated), the honest thing to assert is
  // that the request is still evaluated fresh every time, not crashed or
  // silently short-circuited by the cache code path.
  it("a non-GET admin request (POST /api/admin/collect, unauthorized) bypasses the cache code path without error, on every repeated call", async () => {
    const first = await SELF.fetch(req("POST", "/api/admin/collect"));
    const second = await SELF.fetch(req("POST", "/api/admin/collect"));
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });

  it("a GET on the /api/admin/* prefix bypasses the cache code path without error, on every repeated call", async () => {
    const first = await SELF.fetch(req("GET", "/api/admin/whatever"));
    const second = await SELF.fetch(req("GET", "/api/admin/whatever"));
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });
});

describe("API passthrough", () => {
  it("GET /api/overview -> 200 json (handlePublicApi)", async () => {
    const res = await SELF.fetch(req("GET", "/api/overview"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    await res.text(); // drain the body — see the file-level comment on the cache-put tee
  });

  it("POST /api/admin/collect with no token -> 401 (handleAdmin)", async () => {
    const res = await SELF.fetch(req("POST", "/api/admin/collect"));
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/whatever with no token -> 401, not swallowed by the page router", async () => {
    const res = await SELF.fetch(req("GET", "/api/admin/whatever"));
    expect(res.status).toBe(401);
  });
});

describe("404s", () => {
  it("GET /nope -> 404", async () => {
    const res = await SELF.fetch(req("GET", "/nope"));
    expect(res.status).toBe(404);
  });

  it("POST / (SSR route, wrong method) -> 404", async () => {
    const res = await SELF.fetch(req("POST", "/"));
    expect(res.status).toBe(404);
  });
});

describe("top-level try/catch actually catches admin-branch rejections", () => {
  // Regression for a missing `await` on the handleAdmin branch in
  // src/index.ts: `return handleAdmin(...)` (no await) hands the *promise*
  // back to the async fetch() function without ever `await`-ing it inside
  // the try block, so a rejection inside handleAdmin doesn't get thrown at a
  // point the surrounding try/catch can observe — it becomes an unhandled
  // rejection instead, and would reach the client as an uncaught exception
  // (full stack trace, D1 error text and all) rather than the clean 500 page.
  it("an authorized POST /api/admin/posts that violates the posts.url UNIQUE constraint still 500s through the clean error page, never leaking D1_ERROR/stack", async () => {
    const url = "https://www.v2ex.com/t/9998887";
    // Seed the row directly (bypassing the admin route) so the *next* insert
    // attempt through the real route is guaranteed to hit the UNIQUE
    // constraint immediately inside insertPost — no dependency on outbound
    // network (fetchPostMetrics) timing or availability.
    await env.DB
      .prepare(`insert into posts (url, platform, project, title, published_at) values (?1,'v2ex','nightide','dup', null)`)
      .bind(url)
      .run();

    const res = await SELF.fetch(
      req("POST", "/api/admin/posts", { token: ADMIN_TOKEN, body: { url, project: "nightide" } })
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("D1_ERROR");
    expect(text).not.toContain("UNIQUE constraint failed");
    expect(text).not.toContain("at ("); // no stack-trace-shaped content
    expect(text).toContain("服务暂时不可用");
  });
});

describe("XSS via a stored todo title", () => {
  it("the rendered /todos page contains the escaped title, never the raw <script> tag", async () => {
    await env.DB.prepare(
      `insert into todos (project, source, title, priority, status, created_at) values ('nightide','manual', ?1, 2, 'open', datetime('now'))`
    )
      .bind("<script>alert(1)</script>")
      .run();

    const res = await SELF.fetch(req("GET", "/todos"));
    const text = await res.text();
    expect(text).not.toContain("<script>alert(1)</script>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("the rendered / (overview) page also escapes a <script> todo title surfaced in 「本周建议行动」", async () => {
    await env.DB.prepare(
      `insert into todos (project, source, title, priority, status, created_at) values ('nightide','manual', ?1, 1, 'open', datetime('now'))`
    )
      .bind("<img src=x onerror=alert(2)>")
      .run();

    const res = await SELF.fetch(req("GET", "/"));
    const text = await res.text();
    expect(text).not.toContain("<img src=x onerror=alert(2)>");
    expect(text).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });
});
