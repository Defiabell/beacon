import type { SiteDaily } from "../types";
import type { FetchFn } from "./github";
import type { SiteConfig } from "../config";

// Daily pageviews per site from Cloudflare Web Analytics (RUM).
//
// This is the first real site-traffic source beacon has had. site_daily and the
// overview's sitePv7d were built for GoatCounter, which was never configured —
// the field has read 0 since the project started. Cloudflare Web Analytics needs
// no extra account or token (the same one that reads Worker stats works), so it
// fills that hole with credentials already present.
//
// UNITS: `pageviews` here is RUM's `count`, i.e. pageload events. `visitors` is
// RUM's `sum.visits`, i.e. sessions — NOT unique people. Both names come from
// site_daily's existing columns; the mapping is stated here because the column
// names are looser than what they now hold.
//
// One site == one hostname. defiabell.github.io therefore covers both the blog
// and the nightide game at /nightide/; splitting those needs the requestPath
// dimension, which this collector deliberately does not store (a per-path table
// would be a different feature, and the daily roll-up is what the dashboard
// shows).

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// Site tags are interpolated into the query string (one alias per site, so the
// whole fleet costs a single subrequest). They come from config rather than
// user input, but they are still concatenated into a query, so anything that
// isn't a plain hex tag is rejected outright rather than escaped.
const SITE_TAG = /^[0-9a-f]{32}$/;

export function buildQuery(sites: SiteConfig[]): string {
  const parts = sites.map((s, i) => {
    if (!SITE_TAG.test(s.siteTag)) throw new Error(`invalid siteTag for ${s.host}: ${s.siteTag}`);
    return (
      `s${i}: rumPageloadEventsAdaptiveGroups(limit:200, ` +
      `filter:{siteTag:"${s.siteTag}", date_geq:$start, date_leq:$end}, orderBy:[date_ASC])` +
      `{ count sum{visits} dimensions{date} }`
    );
  });
  return `query($acc:String!,$start:Date!,$end:Date!){viewer{accounts(filter:{accountTag:$acc}){${parts.join(" ")}}}}`;
}

interface RumRow {
  count?: unknown;
  sum?: { visits?: unknown };
  dimensions?: { date?: unknown };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Pure, and exported, for the same reason goatcounter.ts's normalizeTotal is:
// the shape belongs to an external API, so the mapping gets tested directly
// rather than through a live call.
export function normalizeRum(payload: unknown, sites: SiteConfig[]): SiteDaily[] {
  if (typeof payload !== "object" || payload === null) return [];
  const accounts = (payload as { data?: { viewer?: { accounts?: unknown } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const acct = accounts[0] as Record<string, unknown>;

  const out: SiteDaily[] = [];
  sites.forEach((site, i) => {
    const rows = acct[`s${i}`];
    if (!Array.isArray(rows)) return;
    for (const raw of rows as RumRow[]) {
      const date = raw?.dimensions?.date;
      // date is half the primary key; a row without it cannot be stored under
      // any honest key, so it is dropped rather than bucketed somewhere.
      if (typeof date !== "string") continue;
      out.push({
        site: site.host,
        date,
        pageviews: num(raw?.count),
        visitors: num(raw?.sum?.visits)
      });
    }
  });
  return out;
}

// Throws on transport, HTTP, or GraphQL-level errors. A token lacking analytics
// permission returns HTTP 200 with an `errors` array — reading that as "no rows"
// would silently record zero traffic for every site, which is exactly the
// failure mode this whole area keeps producing.
export async function fetchRumDaily(
  sites: SiteConfig[],
  accountId: string,
  token: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchFn = fetch
): Promise<SiteDaily[]> {
  if (sites.length === 0) return [];
  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: buildQuery(sites),
      variables: { acc: accountId, start: startDate, end: endDate }
    })
  });
  if (!res.ok) throw new Error(`cloudflare rum graphql ${res.status}`);
  const payload = await res.json<unknown>();
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown };
    throw new Error(`cloudflare rum error: ${typeof first?.message === "string" ? first.message : "unknown"}`);
  }
  return normalizeRum(payload, sites);
}
