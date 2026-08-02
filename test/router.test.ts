import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { CONFIG } from "../src/config";

function req(method: string, path: string, opts: { token?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;
  return new Request(`https://beacon.internal${path}`, { method, headers });
}

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
  });

  it("GET /posts -> 200 text/html", async () => {
    const res = await SELF.fetch(req("GET", "/posts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });
});

describe("API passthrough", () => {
  it("GET /api/overview -> 200 json (handlePublicApi)", async () => {
    const res = await SELF.fetch(req("GET", "/api/overview"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
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
