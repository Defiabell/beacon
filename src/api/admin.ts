import type { Env } from "../types";
import type { FetchFn } from "../collect/github";
import { backfillStarHistory } from "../collect/github";
import { detectPlatform, fetchPostMetrics } from "../collect/posts";
import { runDailyCollect, ALL_SOURCES } from "../collect/run";
import type { SourceName } from "../collect/run";
import { CONFIG } from "../config";
import { requireAdmin } from "../auth";
import {
  insertPost,
  upsertPostMetrics,
  upsertProjectChannel,
  setTodoStatus,
  upsertStarHistory
} from "../db";

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

// Returns null (rather than throwing) on invalid JSON so callers can turn it
// into a 400 instead of an unhandled rejection / 500.
async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return await req.json<T>();
  } catch {
    return null;
  }
}

interface CreatePostBody {
  url: string;
  project: string;
  title?: string;
  // ISO string, caller-supplied — no validation beyond typeof string (see
  // handleCreatePost); the platform-specific fetchPostMetrics call below
  // doesn't derive this itself, so there's nothing more authoritative to
  // check it against.
  publishedAt?: string;
}

function missingField(name: string): Response {
  return jsonResponse({ error: `missing required field: ${name}` }, 400);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

async function handleCreatePost(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  const body = await parseJsonBody<CreatePostBody>(req);
  if (!body) return jsonResponse({ error: "malformed json body" }, 400);
  if (!isNonEmptyString(body.url)) return missingField("url");
  if (!isNonEmptyString(body.project)) return missingField("project");

  const platform = detectPlatform(body.url);
  if (!platform) return jsonResponse({ error: `could not detect platform for url: ${body.url}` }, 400);

  const id = await insertPost(env.DB, {
    url: body.url,
    platform,
    project: body.project,
    title: body.title ?? "",
    publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : null
  });

  // The post row is committed above; posts.url is UNIQUE, so if the metrics fetch
  // below fails there is no safe way to let this request fail too — a retry would
  // just hit the unique constraint and the post would be stranded with no metrics
  // and no path to get any. Instead we swallow the failure here and report success:
  // the nightly cron's collectPosts (src/collect/run.ts) iterates every stored post
  // and will backfill today's metrics on its next run, same as for any other post.
  const today = new Date().toISOString().slice(0, 10);
  try {
    const metrics = await fetchPostMetrics(body.url, platform, fetchFn);
    await upsertPostMetrics(env.DB, id, today, metrics);
    return jsonResponse({ id }, 201);
  } catch {
    return jsonResponse({ id, metrics: "deferred" }, 201);
  }
}

interface PutChannelBody {
  project: string;
  channelId: string;
  status: "posted" | "planned" | "na";
  postId?: number;
}

async function handlePutChannel(req: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<PutChannelBody>(req);
  if (!body) return jsonResponse({ error: "malformed json body" }, 400);
  if (!isNonEmptyString(body.project)) return missingField("project");
  if (!isNonEmptyString(body.channelId)) return missingField("channelId");
  if (!isNonEmptyString(body.status)) return missingField("status");

  await upsertProjectChannel(env.DB, body.project, body.channelId, body.status, body.postId ?? null);
  return noContent();
}

interface PutTodoBody {
  id: number;
  status: "open" | "done";
}

async function handlePutTodo(req: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<PutTodoBody>(req);
  if (!body) return jsonResponse({ error: "malformed json body" }, 400);
  if (typeof body.id !== "number") return missingField("id");
  if (!isNonEmptyString(body.status)) return missingField("status");

  const doneAt = body.status === "done" ? new Date().toISOString() : null;
  await setTodoStatus(env.DB, body.id, body.status, doneAt);
  return noContent();
}

function isSourceName(s: string): s is SourceName {
  return (ALL_SOURCES as string[]).includes(s);
}

// `?sources=github,posts` restricts a manual collect run to a subset — same
// mechanism the split cron uses (src/collect/run.ts, src/index.ts). Omitted
// entirely -> all four, matching the pre-existing default behavior; an
// unknown name 400s rather than silently being dropped, since the caller
// probably mistyped a source and would otherwise wonder why it never ran.
// See README's "near the subrequest cap" note for why the two-step
// (`?sources=github,posts,goatcounter` then `?sources=audit`) form is the
// recommended way to run a full manual collect by hand.
function parseSourcesParam(url: URL): SourceName[] | { error: string } {
  const raw = url.searchParams.get("sources");
  if (raw === null) return ALL_SOURCES;
  const names = raw
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const unknown = names.filter(n => !isSourceName(n));
  if (unknown.length > 0) return { error: `unknown source(s): ${unknown.join(", ")} (known: ${ALL_SOURCES.join(", ")})` };
  return names as SourceName[];
}

async function handleCollect(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  const sources = parseSourcesParam(new URL(req.url));
  if (!Array.isArray(sources)) return jsonResponse(sources, 400);
  const reports = await runDailyCollect(env, new Date(), fetchFn, sources);
  return jsonResponse(reports, 200);
}

// Per-repo isolation mirrors collectGithub (src/collect/run.ts): one repo's
// stargazers fetch failing (rate limit, transient 5xx, etc.) shouldn't stop the
// rest of the fleet from backfilling.
async function handleBackfill(env: Env, fetchFn: FetchFn): Promise<Response> {
  let succeeded = 0;
  const failures: string[] = [];
  for (const project of CONFIG.projects) {
    try {
      const rows = await backfillStarHistory(env.GITHUB_TOKEN, project.repo, fetchFn);
      await upsertStarHistory(env.DB, project.repo, rows);
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${project.repo}: ${msg}`);
    }
  }
  return jsonResponse({ repos: succeeded, failures }, 200);
}

// `path` is the request's URL.pathname as seen by the caller (Task 12's router),
// passed through untouched — matched here together with req.method. Every route
// goes through requireAdmin first; an unmatched (but authorized) path is a 404.
export async function handleAdmin(req: Request, env: Env, path: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const unauthorized = requireAdmin(req, env);
  if (unauthorized) return unauthorized;

  const route = `${req.method} ${path}`;
  switch (route) {
    case "POST /api/admin/posts":
      return handleCreatePost(req, env, fetchFn);
    case "PUT /api/admin/channels":
      return handlePutChannel(req, env);
    case "PUT /api/admin/todos":
      return handlePutTodo(req, env);
    case "POST /api/admin/collect":
      return handleCollect(req, env, fetchFn);
    case "POST /api/admin/backfill":
      return handleBackfill(env, fetchFn);
    default:
      return jsonResponse({ error: "not found" }, 404);
  }
}
