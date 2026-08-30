import type { FetchFn } from "./github";

// Daily request counts for every Worker in the account, from Cloudflare's
// GraphQL analytics API.
//
// Why this exists: the repo traffic beacon already tracks is not where the
// audience actually lands. 阮一峰周刊's 2026-08-21 issue sent 506 referrals to
// the shotsync *repo* — and, on the same day, 7,384 requests to the shotsync
// *demo Worker*, which is the link the article led with. The bigger surface was
// entirely invisible here.
//
// NOTE ON UNITS: this records REQUESTS, not visits or pageviews, and the two
// differ by more than an order of magnitude. One first-time load of the
// shotsync demo was measured at 14 requests (document + /api/list + manifest +
// favicon + 10 thumbnails); a repeat visit with a warm cache is far fewer, and
// Workers analytics counts bots and scanners alongside people. Requests are
// what Cloudflare actually reports, so requests are what gets stored — any
// visit estimate is the caller's inference and must be labelled as one.

export interface WorkerDaily {
  script: string;
  date: string;
  requests: number;
  errors: number;
  subrequests: number;
}

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `query($acc:String!,$start:Date!,$end:Date!){
  viewer{ accounts(filter:{accountTag:$acc}){
    workersInvocationsAdaptive(limit:1000, filter:{date_geq:$start, date_leq:$end}, orderBy:[date_ASC]){
      sum{ requests errors subrequests }
      dimensions{ scriptName date }
    }
  }}
}`;

interface GraphQLRow {
  sum?: { requests?: unknown; errors?: unknown; subrequests?: unknown };
  dimensions?: { scriptName?: unknown; date?: unknown };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Kept pure and exported so the response mapping can be tested without a live
// account — the same discipline goatcounter.ts's normalizeTotal follows, and
// for the same reason: this shape comes from an external API we do not control.
export function normalizeWorkerRows(payload: unknown): WorkerDaily[] {
  if (typeof payload !== "object" || payload === null) return [];
  const accounts = (payload as { data?: { viewer?: { accounts?: unknown } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const rows = (accounts[0] as { workersInvocationsAdaptive?: unknown }).workersInvocationsAdaptive;
  if (!Array.isArray(rows)) return [];

  const out: WorkerDaily[] = [];
  for (const raw of rows as GraphQLRow[]) {
    const script = raw?.dimensions?.scriptName;
    const date = raw?.dimensions?.date;
    // Both dimensions are the primary key downstream; a row missing either is
    // unusable, so it is dropped rather than stored under a placeholder.
    if (typeof script !== "string" || typeof date !== "string") continue;
    out.push({
      script,
      date,
      requests: num(raw?.sum?.requests),
      errors: num(raw?.sum?.errors),
      subrequests: num(raw?.sum?.subrequests)
    });
  }
  return out;
}

// Throws on a transport error, an HTTP error, or a GraphQL `errors` array —
// runDailyCollect's per-source isolation turns any of those into a recorded
// failed run rather than a silent zero, which matters here because "no rows"
// and "the query was rejected" would otherwise look identical.
export async function fetchWorkerDaily(
  accountId: string,
  token: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchFn = fetch
): Promise<WorkerDaily[]> {
  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { acc: accountId, start: startDate, end: endDate } })
  });
  if (!res.ok) throw new Error(`cloudflare graphql ${res.status}`);
  const payload = await res.json<unknown>();
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown };
    throw new Error(`cloudflare graphql error: ${typeof first?.message === "string" ? first.message : "unknown"}`);
  }
  return normalizeWorkerRows(payload);
}
