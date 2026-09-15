import type { WorkerDaily } from "./cloudflare";
import type { FetchFn } from "./github";

// Daily request counts for every Cloudflare Pages project's Functions, from
// the pagesFunctionsInvocationsAdaptiveGroups GraphQL dataset.
//
// Why this exists: workersInvocationsAdaptive (src/collect/cloudflare.ts) does
// NOT cover Pages Functions. Confirmed live 2026-09-15: 一息 (Pages project
// `yixi-app`, https://yixi-app.pages.dev) showed only its small helper Worker
// `yixi` (19 requests over 7 days) while this dataset reported its Functions
// traffic — internal script `pages-worker--18671371-production` — at 7,585
// requests over the same window. The real traffic was entirely invisible.
//
// Every Pages project runs its Functions under an internal script named
// `pages-worker--<id>-production` (and a `-preview` sibling), which lives in
// its own scriptName namespace, disjoint from ordinary Worker names — hence a
// separate dataset and a separate collector rather than folding into
// cloudflare.ts's query. Resolving that internal id back to the project's
// public name/host needs a second call, the Pages REST project list — see
// fetchPagesProjects and resolvePagesFunctionsToWorkerDaily below.
//
// This dataset has no `subrequests` field (unlike workersInvocationsAdaptive),
// so resolved rows carry subrequests: 0 and land in the existing worker_daily
// table (src/db.ts's upsertWorkerDaily) rather than a new one — every column
// that table has is still populated, just with a source that doesn't measure
// one of them.
//
// NOTE ON UNITS: same discipline as cloudflare.ts — these are REQUESTS, not
// visits or pageviews, and no visit estimate is invented here. Only a script
// with a measured requests-per-visit divisor gets one (see src/ui/pages.ts's
// MEASURED_REQUESTS_PER_VISIT), and no Pages project has been measured yet.

export interface PagesFunctionsDaily {
  scriptName: string; // e.g. "pages-worker--18671371-production"
  date: string;
  requests: number;
  errors: number;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const FUNCTIONS_QUERY = `query($acc:String!,$start:Date!,$end:Date!){
  viewer{ accounts(filter:{accountTag:$acc}){
    pagesFunctionsInvocationsAdaptiveGroups(limit:1000, filter:{date_geq:$start, date_leq:$end}, orderBy:[date_ASC]){
      sum{ requests errors }
      dimensions{ scriptName date }
    }
  }}
}`;

interface FunctionsRow {
  sum?: { requests?: unknown; errors?: unknown };
  dimensions?: { scriptName?: unknown; date?: unknown };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Pure and exported for the same reason cloudflare.ts's normalizeWorkerRows
// is: this shape belongs to an external API, so the mapping is tested
// directly rather than only through a live call.
export function normalizePagesFunctionsRows(payload: unknown): PagesFunctionsDaily[] {
  if (typeof payload !== "object" || payload === null) return [];
  const accounts = (payload as { data?: { viewer?: { accounts?: unknown } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const rows = (accounts[0] as { pagesFunctionsInvocationsAdaptiveGroups?: unknown })
    .pagesFunctionsInvocationsAdaptiveGroups;
  if (!Array.isArray(rows)) return [];

  const out: PagesFunctionsDaily[] = [];
  for (const raw of rows as FunctionsRow[]) {
    const scriptName = raw?.dimensions?.scriptName;
    const date = raw?.dimensions?.date;
    // Both dimensions are half the eventual (script, date) primary key; a row
    // missing either is unusable, so it is dropped rather than stored under a
    // placeholder — same rule as normalizeWorkerRows.
    if (typeof scriptName !== "string" || typeof date !== "string") continue;
    out.push({ scriptName, date, requests: num(raw?.sum?.requests), errors: num(raw?.sum?.errors) });
  }
  return out;
}

// Throws on a transport error, an HTTP error, or a GraphQL `errors` array —
// same contract as fetchWorkerDaily, and for the same reason: a token lacking
// this dataset's permission returns HTTP 200 with an `errors` array, and
// reading that as "no rows" would silently record zero Pages traffic.
export async function fetchPagesFunctionsDaily(
  accountId: string,
  token: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchFn = fetch
): Promise<PagesFunctionsDaily[]> {
  const res = await fetchFn(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: FUNCTIONS_QUERY, variables: { acc: accountId, start: startDate, end: endDate } })
  });
  if (!res.ok) throw new Error(`cloudflare pages-functions graphql ${res.status}`);
  const payload = await res.json<unknown>();
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown };
    throw new Error(
      `cloudflare pages-functions graphql error: ${typeof first?.message === "string" ? first.message : "unknown"}`
    );
  }
  return normalizePagesFunctionsRows(payload);
}

// --- Project name resolution ---
//
// The Functions dataset only ever names the internal `pages-worker--<id>-*`
// script. Turning that into something a person recognizes on the dashboard
// needs the Pages project list, which carries both that same internal id and
// the project's public `*.pages.dev` host.

export interface PagesProject {
  name: string;
  subdomain: string; // e.g. "yixi-app.pages.dev"
  productionScriptName: string; // e.g. "pages-worker--18671371-production"
}

interface RawPagesProject {
  name?: unknown;
  subdomain?: unknown;
  production_script_name?: unknown;
}

// Pure mapper for one REST response's `result` array — tested the same way
// as the GraphQL normalizer above. A project missing either field this
// collector needs (subdomain, which becomes the stored `script`; or
// production_script_name, the join key back to the Functions dataset) is
// dropped: it cannot be resolved to a row either way, and there is nothing
// honest to store it under.
export function normalizePagesProjects(payload: unknown): PagesProject[] {
  if (typeof payload !== "object" || payload === null) return [];
  const result = (payload as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  const out: PagesProject[] = [];
  for (const raw of result as RawPagesProject[]) {
    const name = raw?.name;
    const subdomain = raw?.subdomain;
    const productionScriptName = raw?.production_script_name;
    if (typeof name !== "string" || typeof subdomain !== "string" || typeof productionScriptName !== "string") {
      continue;
    }
    out.push({ name, subdomain, productionScriptName });
  }
  return out;
}

// Defensive backstop against a runaway pagination loop (malformed/self-
// referential result_info), same role as github.ts's MAX_STARGAZER_PAGES. A
// personal account's project list is a handful of pages at most.
const MAX_PROJECT_PAGES = 20;

// Throws on a transport error, an HTTP error, or `success:false` — same
// "never silently report zero" contract as the GraphQL fetchers above,
// applied to Cloudflare's REST envelope instead of GraphQL's.
export async function fetchPagesProjects(
  accountId: string,
  token: string,
  fetchFn: FetchFn = fetch
): Promise<PagesProject[]> {
  const out: PagesProject[] = [];
  for (let page = 1; page <= MAX_PROJECT_PAGES; page++) {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`cloudflare pages projects ${res.status}`);
    const payload = await res.json<unknown>();
    if ((payload as { success?: unknown }).success !== true) {
      const errors = (payload as { errors?: unknown }).errors;
      const first = Array.isArray(errors) ? (errors[0] as { message?: unknown }) : undefined;
      throw new Error(`cloudflare pages projects error: ${typeof first?.message === "string" ? first.message : "unknown"}`);
    }
    out.push(...normalizePagesProjects(payload));

    const info = (payload as { result_info?: { total_pages?: unknown } }).result_info;
    const totalPages = typeof info?.total_pages === "number" ? info.total_pages : 1;
    if (page >= totalPages) break;
  }
  return out;
}

// --- Joining Functions rows onto worker_daily's shape ---

// Maps Functions rows (keyed by the internal `pages-worker--<id>-production`
// scriptName) onto WorkerDaily rows keyed by the project's public pages.dev
// host, so they upsert into worker_daily next to ordinary Workers and render
// in the same "自有服务请求量" list (src/ui/pages.ts's workersSection)
// instead of a separate one.
//
// A row whose scriptName does not match any known project's
// productionScriptName is NOT dropped — it is stored under its raw
// scriptName instead. That keeps a mapping gap (a renamed project, an id this
// collector's REST call didn't return) visible as an odd `pages-worker--...`
// row on the dashboard rather than silently discarding real traffic.
export function resolvePagesFunctionsToWorkerDaily(
  rows: PagesFunctionsDaily[],
  projects: PagesProject[]
): WorkerDaily[] {
  const hostByScript = new Map<string, string>();
  for (const p of projects) hostByScript.set(p.productionScriptName, p.subdomain);

  return rows.map(r => ({
    script: hostByScript.get(r.scriptName) ?? r.scriptName,
    date: r.date,
    requests: r.requests,
    errors: r.errors,
    subrequests: 0
  }));
}
