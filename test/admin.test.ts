import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { timingSafeEqual } from "../src/auth";
import { handleAdmin } from "../src/api/admin";
import { CONFIG } from "../src/config";
import * as db from "../src/db";
import v2exFixture from "./fixtures/v2ex-topic.json";

const ADMIN_TOKEN = "test-admin-token"; // bound in vitest.config.ts miniflare bindings

function req(method: string, path: string, opts: { token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers["Authorization"] = `Bearer ${opts.token ?? ADMIN_TOKEN}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(`https://beacon.internal${path}`, init);
}

const v2exStub: typeof fetch = async () => Response.json(v2exFixture);

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });
  it("returns false for strings that differ in one character", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length strings (still runs the full comparison loop)", () => {
    expect(timingSafeEqual("short", "much-longer-string")).toBe(false);
    expect(timingSafeEqual("", "nonempty")).toBe(false);
  });
});

describe("handleAdmin: auth", () => {
  it("401s with no Authorization header", async () => {
    const res = await handleAdmin(req("POST", "/api/admin/collect", { token: null }), env, "/api/admin/collect");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("401s with a wrong token", async () => {
    const res = await handleAdmin(
      req("POST", "/api/admin/collect", { token: "wrong-token" }),
      env,
      "/api/admin/collect"
    );
    expect(res.status).toBe(401);
  });

  it("401s with a malformed Authorization header (missing Bearer prefix)", async () => {
    const request = new Request("https://beacon.internal/api/admin/collect", {
      method: "POST",
      headers: { Authorization: ADMIN_TOKEN }
    });
    const res = await handleAdmin(request, env, "/api/admin/collect");
    expect(res.status).toBe(401);
  });

  it("never leaks the admin token into an authenticated request's own URL", async () => {
    // Sanity check on the test helper itself: the token lives only in the
    // Authorization header, never appended as a query param.
    const request = req("POST", "/api/admin/collect");
    expect(request.url).not.toContain(ADMIN_TOKEN);
  });
});

describe("handleAdmin: unknown path", () => {
  it("404s for a path with no matching route", async () => {
    const res = await handleAdmin(req("GET", "/api/admin/bogus"), env, "/api/admin/bogus");
    expect(res.status).toBe(404);
  });

  it("404s for a known path with a mismatched method", async () => {
    const res = await handleAdmin(req("DELETE", "/api/admin/posts"), env, "/api/admin/posts");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/posts", () => {
  it("detects platform, inserts the post, and captures today's metrics", async () => {
    const url = "https://www.v2ex.com/t/1229945#reply2";
    const res = await handleAdmin(
      req("POST", "/api/admin/posts", { body: { url, project: "nightide", title: "my post" } }),
      env,
      "/api/admin/posts",
      v2exStub
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    expect(typeof body.id).toBe("number");

    const post = await env.DB
      .prepare("select url, platform, project, title, published_at as publishedAt from posts where id=?1")
      .bind(body.id)
      .first<{ url: string; platform: string; project: string; title: string; publishedAt: string | null }>();
    expect(post).toEqual({ url, platform: "v2ex", project: "nightide", title: "my post", publishedAt: null });

    const today = new Date().toISOString().slice(0, 10);
    const metrics = await env.DB
      .prepare("select date, replies from post_metrics where post_id=?1")
      .bind(body.id)
      .first<{ date: string; replies: number }>();
    expect(metrics).toEqual({ date: today, replies: v2exFixture[0].replies });
  });

  it("defaults title to an empty string when omitted", async () => {
    const url = "https://www.v2ex.com/t/222";
    const res = await handleAdmin(
      req("POST", "/api/admin/posts", { body: { url, project: "nightide" } }),
      env,
      "/api/admin/posts",
      v2exStub
    );
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: number }>();
    const post = await env.DB.prepare("select title from posts where id=?1").bind(id).first<{ title: string }>();
    expect(post?.title).toBe("");
  });

  it("400s when the platform can't be detected from the url", async () => {
    const res = await handleAdmin(
      req("POST", "/api/admin/posts", { body: { url: "https://example.com/whatever", project: "nightide" } }),
      env,
      "/api/admin/posts",
      v2exStub
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("example.com");
  });

  it("400s on a malformed JSON body", async () => {
    const res = await handleAdmin(
      req("POST", "/api/admin/posts", { body: "{not json" }),
      env,
      "/api/admin/posts",
      v2exStub
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/channels", () => {
  it("upserts a project/channel pairing", async () => {
    const res = await handleAdmin(
      req("PUT", "/api/admin/channels", {
        body: { project: "nightide", channelId: "r-nightide-fans", status: "planned" }
      }),
      env,
      "/api/admin/channels"
    );
    expect(res.status).toBe(204);

    const row = await env.DB
      .prepare("select status, post_id as postId from project_channels where project=?1 and channel_id=?2")
      .bind("nightide", "r-nightide-fans")
      .first<{ status: string; postId: number | null }>();
    expect(row).toEqual({ status: "planned", postId: null });
  });

  it("updates an existing pairing on a second call (upsert, not duplicate)", async () => {
    await handleAdmin(
      req("PUT", "/api/admin/channels", { body: { project: "nightide", channelId: "v2ex", status: "planned" } }),
      env,
      "/api/admin/channels"
    );
    const res = await handleAdmin(
      req("PUT", "/api/admin/channels", {
        body: { project: "nightide", channelId: "v2ex", status: "posted", postId: 7 }
      }),
      env,
      "/api/admin/channels"
    );
    expect(res.status).toBe(204);

    const rows = await env.DB
      .prepare("select status, post_id as postId from project_channels where project=?1 and channel_id=?2")
      .bind("nightide", "v2ex")
      .all<{ status: string; postId: number | null }>();
    expect(rows.results).toEqual([{ status: "posted", postId: 7 }]);
  });

  it("400s on a malformed JSON body", async () => {
    const res = await handleAdmin(
      req("PUT", "/api/admin/channels", { body: "not json" }),
      env,
      "/api/admin/channels"
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/admin/todos", () => {
  async function insertTodo(status: "open" | "done"): Promise<number> {
    const res = await env.DB
      .prepare(
        `insert into todos (project, source, title, priority, status, created_at)
         values ('nightide', 'manual', 'todo-' || random(), 2, ?1, datetime('now'))`
      )
      .bind(status)
      .run();
    return res.meta.last_row_id;
  }

  it("flips status to done and sets done_at", async () => {
    const id = await insertTodo("open");
    const res = await handleAdmin(req("PUT", "/api/admin/todos", { body: { id, status: "done" } }), env, "/api/admin/todos");
    expect(res.status).toBe(204);

    const row = await env.DB
      .prepare("select status, done_at as doneAt from todos where id=?1")
      .bind(id)
      .first<{ status: string; doneAt: string | null }>();
    expect(row?.status).toBe("done");
    expect(row?.doneAt).not.toBeNull();
  });

  it("flips status back to open and clears done_at", async () => {
    const id = await insertTodo("done");
    const res = await handleAdmin(req("PUT", "/api/admin/todos", { body: { id, status: "open" } }), env, "/api/admin/todos");
    expect(res.status).toBe(204);

    const row = await env.DB
      .prepare("select status, done_at as doneAt from todos where id=?1")
      .bind(id)
      .first<{ status: string; doneAt: string | null }>();
    expect(row).toEqual({ status: "open", doneAt: null });
  });

  it("400s on a malformed JSON body", async () => {
    const res = await handleAdmin(req("PUT", "/api/admin/todos", { body: "not json" }), env, "/api/admin/todos");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/collect", () => {
  it("runs the daily collector and returns its per-source reports", async () => {
    const alwaysNotFound: typeof fetch = async () => new Response("not found", { status: 404 });
    const res = await handleAdmin(req("POST", "/api/admin/collect"), env, "/api/admin/collect", alwaysNotFound);
    expect(res.status).toBe(200);
    const reports = await res.json<{ source: string; ok: boolean }[]>();
    expect(reports.map(r => r.source).sort()).toEqual(["audit", "github", "goatcounter", "posts"]);
  });
});

describe("POST /api/admin/backfill", () => {
  it("backfills star history for every configured project", async () => {
    const stub: typeof fetch = async input => {
      const url = String(input);
      if (url.includes("/stargazers")) {
        return new Response(JSON.stringify([{ starred_at: "2026-07-01T00:00:00Z" }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const res = await handleAdmin(req("POST", "/api/admin/backfill"), env, "/api/admin/backfill", stub);
    expect(res.status).toBe(200);
    const body = await res.json<{ repos: number }>();
    expect(body.repos).toBe(CONFIG.projects.length);

    for (const project of CONFIG.projects) {
      const series = await db.getStarSeries(env.DB, project.repo);
      expect(series).toEqual([{ date: "2026-07-01", stars: 1 }]);
    }
  });
});
