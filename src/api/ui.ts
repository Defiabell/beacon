// Thin form handlers for the browser-facing, no-JS write controls added to
// the SSR pages (src/ui/pages.ts): a checkbox to toggle a todo, a form to
// register a post, and a per-cell form to set channel coverage. Every route
// here parses an `application/x-www-form-urlencoded` body (plain HTML forms
// can only GET/POST that, never PUT/JSON) and then calls the exact same
// db.ts functions / createPost helper the JSON admin API (src/api/admin.ts)
// calls — no business logic is duplicated — before doing a 303
// redirect back to wherever the form was rendered (POST/redirect/GET).
//
// Every route requires admin auth via the same requireAdmin used by
// src/api/admin.ts (header or cookie, see src/auth.ts) — an unauthenticated
// request gets the same 401 JSON body handleAdmin returns.
import type { Env } from "../types";
import type { FetchFn } from "../collect/github";
import { requireAdmin } from "../auth";
import { setTodoStatus, updateChannelStatus } from "../db";
import { createPost, type CreatePostInput } from "./admin";
import { parseForm, formString, safeRedirectPath } from "../http-forms";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// A checkbox present in the submitted form (any value) means "done"; absent
// means "open" — this is the entire toggle semantic src/ui/pages.ts's
// per-todo <form> relies on: the checkbox's checked-ness at submit time *is*
// the desired next state.
async function handleUiTodo(req: Request, env: Env): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return badRequest("malformed form body");

  const idRaw = formString(form, "id");
  const id = idRaw !== null ? Number(idRaw) : NaN;
  if (!Number.isInteger(id)) return badRequest("missing or invalid field: id");

  const nextStatus: "open" | "done" = form.get("done") !== null ? "done" : "open";
  const doneAt = nextStatus === "done" ? new Date().toISOString() : null;
  await setTodoStatus(env.DB, id, nextStatus, doneAt);

  return seeOther(safeRedirectPath(formString(form, "returnTo"), "/todos"));
}

async function handleUiPost(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return badRequest("malformed form body");

  const input: CreatePostInput = {
    url: formString(form, "url"),
    project: formString(form, "project"),
    title: formString(form, "title"),
    publishedAt: formString(form, "publishedAt")
  };
  const result = await createPost(env, input, fetchFn);
  if (!result.ok) return badRequest(result.error);

  return seeOther(safeRedirectPath(formString(form, "returnTo"), "/posts"));
}

const CHANNEL_STATUSES = new Set(["posted", "planned", "na"]);

async function handleUiChannel(req: Request, env: Env): Promise<Response> {
  const form = await parseForm(req);
  if (!form) return badRequest("malformed form body");

  const project = formString(form, "project");
  const channelId = formString(form, "channelId");
  const status = formString(form, "status");
  if (!project) return badRequest("missing required field: project");
  if (!channelId) return badRequest("missing required field: channelId");
  if (!status || !CHANNEL_STATUSES.has(status)) return badRequest("missing or invalid field: status");

  // updateChannelStatus (not upsertProjectChannel): this form has no field to
  // supply a postId, so it must not clobber one an earlier JSON-admin-API call
  // set (see updateChannelStatus's doc comment in src/db.ts).
  await updateChannelStatus(env.DB, project, channelId, status as "posted" | "planned" | "na");

  return seeOther(safeRedirectPath(formString(form, "returnTo"), "/matrix"));
}

// `path` is the request's URL.pathname, matched together with req.method —
// mirrors handleAdmin's (src/api/admin.ts) contract. `fetchFn` defaults to the
// real global fetch and is only ever overridden by tests (same pattern as
// handleAdmin), since handleUiPost's createPost call can reach out to a
// post's platform API for its initial metrics.
export async function handleUi(req: Request, env: Env, path: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const unauthorized = requireAdmin(req, env);
  if (unauthorized) return unauthorized;

  const route = `${req.method} ${path}`;
  switch (route) {
    case "POST /ui/todo":
      return handleUiTodo(req, env);
    case "POST /ui/post":
      return handleUiPost(req, env, fetchFn);
    case "POST /ui/channel":
      return handleUiChannel(req, env);
    default:
      return notFound();
  }
}
