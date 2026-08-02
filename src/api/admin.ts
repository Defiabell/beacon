import type { Env } from "../types";
import type { FetchFn } from "../collect/github";
import { backfillStarHistory } from "../collect/github";
import { detectPlatform, fetchPostMetrics } from "../collect/posts";
import { runDailyCollect } from "../collect/run";
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
}

async function handleCreatePost(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  const body = await parseJsonBody<CreatePostBody>(req);
  if (!body) return jsonResponse({ error: "malformed json body" }, 400);

  const platform = detectPlatform(body.url);
  if (!platform) return jsonResponse({ error: `could not detect platform for url: ${body.url}` }, 400);

  const id = await insertPost(env.DB, {
    url: body.url,
    platform,
    project: body.project,
    title: body.title ?? "",
    publishedAt: null
  });

  const today = new Date().toISOString().slice(0, 10);
  const metrics = await fetchPostMetrics(body.url, platform, fetchFn);
  await upsertPostMetrics(env.DB, id, today, metrics);

  return jsonResponse({ id }, 201);
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

  const doneAt = body.status === "done" ? new Date().toISOString() : null;
  await setTodoStatus(env.DB, body.id, body.status, doneAt);
  return noContent();
}

async function handleCollect(env: Env, fetchFn: FetchFn): Promise<Response> {
  const reports = await runDailyCollect(env, new Date(), fetchFn);
  return jsonResponse(reports, 200);
}

async function handleBackfill(env: Env, fetchFn: FetchFn): Promise<Response> {
  for (const project of CONFIG.projects) {
    const rows = await backfillStarHistory(env.GITHUB_TOKEN, project.repo, fetchFn);
    await upsertStarHistory(env.DB, project.repo, rows);
  }
  return jsonResponse({ repos: CONFIG.projects.length }, 200);
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
      return handleCollect(env, fetchFn);
    case "POST /api/admin/backfill":
      return handleBackfill(env, fetchFn);
    default:
      return jsonResponse({ error: "not found" }, 404);
  }
}
