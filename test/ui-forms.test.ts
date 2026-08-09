import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleUi } from "../src/api/ui";
import v2exFixture from "./fixtures/v2ex-topic.json";

const ADMIN_TOKEN = "test-admin-token"; // bound in vitest.config.ts miniflare bindings

function formReq(method: string, path: string, fields: Record<string, string>, opts: { token?: string | null; cookie?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.token !== undefined && opts.token !== null) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  return new Request(`https://beacon.internal${path}`, {
    method,
    headers,
    body: new URLSearchParams(fields).toString()
  });
}

const v2exStub: typeof fetch = async () => Response.json(v2exFixture);

describe("handleUi: auth gating", () => {
  it("401s POST /ui/todo with no Authorization header and no cookie", async () => {
    const res = await handleUi(formReq("POST", "/ui/todo", { id: "1" }), env, "/ui/todo");
    expect(res.status).toBe(401);
  });

  it("401s POST /ui/post with a wrong Authorization header", async () => {
    const res = await handleUi(formReq("POST", "/ui/post", { url: "https://www.v2ex.com/t/1" }, { token: "wrong" }), env, "/ui/post");
    expect(res.status).toBe(401);
  });

  it("401s POST /ui/channel with a wrong cookie", async () => {
    const res = await handleUi(
      formReq("POST", "/ui/channel", { project: "nightide", channelId: "v2ex", status: "posted" }, { cookie: "beacon_admin=wrong" }),
      env,
      "/ui/channel"
    );
    expect(res.status).toBe(401);
  });

  it("404s an unmatched /ui/* path even when authorized", async () => {
    const res = await handleUi(formReq("POST", "/ui/bogus", {}, { token: ADMIN_TOKEN }), env, "/ui/bogus");
    expect(res.status).toBe(404);
  });
});

describe("POST /ui/todo", () => {
  async function insertTodo(status: "open" | "done"): Promise<number> {
    const res = await env.DB.prepare(
      `insert into todos (project, source, title, priority, status, created_at)
       values ('nightide', 'manual', 'ui-todo-' || random(), 2, ?1, datetime('now'))`
    )
      .bind(status)
      .run();
    return res.meta.last_row_id;
  }

  it("checking the box (done=1 present) marks an open todo done and sets done_at, then 303s to returnTo", async () => {
    const id = await insertTodo("open");
    const res = await handleUi(
      formReq("POST", "/ui/todo", { id: String(id), done: "1", returnTo: "/todos?status=done" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/todo"
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/todos?status=done");

    const row = await env.DB.prepare("select status, done_at as doneAt from todos where id=?1").bind(id).first<{ status: string; doneAt: string | null }>();
    expect(row?.status).toBe("done");
    expect(row?.doneAt).not.toBeNull();
  });

  it("submitting with the box unchecked (no done field) reopens a done todo and clears done_at", async () => {
    const id = await insertTodo("done");
    const res = await handleUi(formReq("POST", "/ui/todo", { id: String(id), returnTo: "/todos" }, { token: ADMIN_TOKEN }), env, "/ui/todo");
    expect(res.status).toBe(303);

    const row = await env.DB.prepare("select status, done_at as doneAt from todos where id=?1").bind(id).first<{ status: string; doneAt: string | null }>();
    expect(row).toEqual({ status: "open", doneAt: null });
  });

  it("falls back to /todos when returnTo is absent", async () => {
    const id = await insertTodo("open");
    const res = await handleUi(formReq("POST", "/ui/todo", { id: String(id), done: "1" }, { token: ADMIN_TOKEN }), env, "/ui/todo");
    expect(res.headers.get("Location")).toBe("/todos");
  });

  it("falls back to /todos when returnTo is an open-redirect attempt", async () => {
    const id = await insertTodo("open");
    const res = await handleUi(
      formReq("POST", "/ui/todo", { id: String(id), done: "1", returnTo: "https://evil.example" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/todo"
    );
    expect(res.headers.get("Location")).toBe("/todos");
  });

  it("400s with a missing/non-numeric id", async () => {
    const res = await handleUi(formReq("POST", "/ui/todo", { done: "1" }, { token: ADMIN_TOKEN }), env, "/ui/todo");
    expect(res.status).toBe(400);
  });
});

describe("POST /ui/post", () => {
  it("registers a post via the same createPost path as the JSON admin API, including its metrics-deferred fallback", async () => {
    const url = "https://www.v2ex.com/t/4440001";
    const failingFetch: typeof fetch = async () => new Response("boom", { status: 500 });
    const res = await handleUi(
      formReq("POST", "/ui/post", { url, project: "nightide", returnTo: "/posts" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/post",
      failingFetch
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/posts");

    const post = await env.DB.prepare("select project, title, published_at as publishedAt from posts where url=?1").bind(url).first<{ project: string; title: string; publishedAt: string | null }>();
    expect(post).toEqual({ project: "nightide", title: "", publishedAt: null });
    // metrics fetch failed -> deferred, exactly like handleCreatePost's contract (no row yet)
    const metrics = await env.DB.prepare("select * from post_metrics where post_id=(select id from posts where url=?1)").bind(url).first();
    expect(metrics).toBeNull();
  });

  it("stores title and publishedAt when provided, and successfully fetches metrics via the injected fetchFn", async () => {
    const url = "https://www.v2ex.com/t/4440002";
    const res = await handleUi(
      formReq(
        "POST",
        "/ui/post",
        { url, project: "nightide", title: "my post", publishedAt: "2026-08-01T09:00:00Z" },
        { token: ADMIN_TOKEN }
      ),
      env,
      "/ui/post",
      v2exStub
    );
    expect(res.status).toBe(303);

    const post = await env.DB.prepare("select title, published_at as publishedAt from posts where url=?1").bind(url).first<{ title: string; publishedAt: string }>();
    expect(post).toEqual({ title: "my post", publishedAt: "2026-08-01T09:00:00Z" });
    const metrics = await env.DB.prepare("select replies from post_metrics where post_id=(select id from posts where url=?1)").bind(url).first<{ replies: number }>();
    expect(metrics?.replies).toBe(v2exFixture[0].replies);
  });

  it("400s (plain text) when the url is missing", async () => {
    const res = await handleUi(formReq("POST", "/ui/post", { project: "nightide" }, { token: ADMIN_TOKEN }), env, "/ui/post", v2exStub);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("url");
  });

  it("400s when the platform can't be detected", async () => {
    const res = await handleUi(
      formReq("POST", "/ui/post", { url: "https://example.com/x", project: "nightide" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/post",
      v2exStub
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /ui/channel", () => {
  it("upserts a project/channel status pairing, then 303s to returnTo", async () => {
    const res = await handleUi(
      formReq("POST", "/ui/channel", { project: "nightide", channelId: "ui-test-channel", status: "planned", returnTo: "/matrix" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/channel"
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/matrix");

    const row = await env.DB.prepare("select status, post_id as postId from project_channels where project=?1 and channel_id=?2")
      .bind("nightide", "ui-test-channel")
      .first<{ status: string; postId: number | null }>();
    expect(row).toEqual({ status: "planned", postId: null });
  });

  it("400s on a missing status", async () => {
    const res = await handleUi(
      formReq("POST", "/ui/channel", { project: "nightide", channelId: "v2ex" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/channel"
    );
    expect(res.status).toBe(400);
  });

  it("400s on an invalid status value (not one of posted/planned/na)", async () => {
    const res = await handleUi(
      formReq("POST", "/ui/channel", { project: "nightide", channelId: "v2ex", status: "bogus" }, { token: ADMIN_TOKEN }),
      env,
      "/ui/channel"
    );
    expect(res.status).toBe(400);
  });
});

describe("/ui/* is excluded from the shared edge cache, same as /api/admin/*", () => {
  it("an unauthorized POST /ui/todo bypasses the cache code path without error, on every repeated call", async () => {
    const first = await SELF.fetch(formReq("POST", "/ui/todo", { id: "1" }));
    const second = await SELF.fetch(formReq("POST", "/ui/todo", { id: "1" }));
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });
});
