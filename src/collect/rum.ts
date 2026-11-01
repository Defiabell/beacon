import type { SiteDaily, SiteReferrerDaily } from "../types";
import type { FetchFn } from "./github";
import { isZoneSite, type SiteConfig } from "../config";
import { referrerLabel } from "../surfaces";

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
//
// A zone-level site (SiteConfig.hosts) is the one case where a tag spans many
// hostnames. Its alias adds the requestHost dimension and each row is stored
// under that hostname, so the dashboard sees gulliver.defiabell.com and
// mythmesh.defiabell.com as separate sites even though one tag reports both.

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// Site tags are interpolated into the query string (one alias per site, so the
// whole fleet costs a single subrequest). They come from config rather than
// user input, but they are still concatenated into a query, so anything that
// isn't a plain hex tag is rejected outright rather than escaped.
const SITE_TAG = /^[0-9a-f]{32}$/;

export function buildQuery(sites: SiteConfig[]): string {
  const parts = sites.map((s, i) => {
    if (!SITE_TAG.test(s.siteTag)) throw new Error(`invalid siteTag for ${s.host}: ${s.siteTag}`);
    // A zone-level alias returns hosts × days rows instead of days, so it gets
    // the host dimension and a limit sized for a dozen hosts over the re-fetch
    // window rather than for one hostname.
    const zone = isZoneSite(s);
    return (
      `s${i}: rumPageloadEventsAdaptiveGroups(limit:${zone ? 1000 : 200}, ` +
      `filter:{siteTag:"${s.siteTag}", date_geq:$start, date_leq:$end}, orderBy:[date_ASC])` +
      `{ count sum{visits} dimensions{date${zone ? " requestHost" : ""}} }`
    );
  });
  return `query($acc:String!,$start:Date!,$end:Date!){viewer{accounts(filter:{accountTag:$acc}){${parts.join(" ")}}}}`;
}

interface RumRow {
  count?: unknown;
  sum?: { visits?: unknown };
  dimensions?: { date?: unknown; requestHost?: unknown };
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
      // For a zone-level site the hostname is the other half of the key. RUM
      // reports the odd pageload with an empty requestHost; folding those into
      // the apex would inflate it, so they are dropped the same way.
      let host = site.host;
      if (isZoneSite(site)) {
        const rh = raw?.dimensions?.requestHost;
        if (typeof rh !== "string" || rh === "") continue;
        host = rh.toLowerCase();
      }
      out.push({
        site: host,
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
  const accounts = (payload as { data?: { viewer?: { accounts?: Record<string, unknown>[] } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1 ||
      sites.some((_, i) => !Array.isArray(accounts[0]?.[`s${i}`]))) {
    throw new Error("cloudflare rum response missing account or site data");
  }
  for (let i = 0; i < sites.length; i++) {
    for (const raw of accounts[0][`s${i}`] as RumRow[]) {
      if (typeof raw?.dimensions?.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(raw.dimensions.date) ||
          typeof raw.count !== "number" || !Number.isFinite(raw.count) ||
          typeof raw.sum?.visits !== "number" || !Number.isFinite(raw.sum.visits) ||
          (isZoneSite(sites[i]) && typeof raw.dimensions.requestHost !== "string")) {
        throw new Error("cloudflare rum response contains invalid daily data");
      }
    }
  }
  return normalizeRum(payload, sites);
}

// ---- referrers --------------------------------------------------------------
//
// A second query over the same dataset, split by refererHost (+ refererPath,
// see src/surfaces.ts referrerLabel). Separate from buildQuery rather than
// added as dimensions to it: the daily totals must stay one row per (host,
// day) so a referrer-cardinality blow-up can never truncate them, and the two
// queries cost one subrequest each either way.
//
// Why this exists: JS-based analytics only ever see humans who arrive with a
// Referer header, and that is exactly the one place an AI answer engine's
// contribution is measurable. The repo-side surfaces (GitHub's referrers) have
// read "AI 答案引擎: 0" since launch; this is the site-side half of that
// question. Measured 2026-11-01 on the zone-level site: refererHost is
// populated (www.v2ex.com, github.com, bing.com, weixin110.qq.com) and the
// odd row carries a refererPath, so host-level classification is real.
export function buildReferrerQuery(sites: SiteConfig[]): string {
  const parts = sites.map((s, i) => {
    if (!SITE_TAG.test(s.siteTag)) throw new Error(`invalid siteTag for ${s.host}: ${s.siteTag}`);
    const zone = isZoneSite(s);
    // Rows are (referrer × day), or (host × referrer × day) for a zone, so the
    // limit is sized a few times above the daily query's.
    return (
      `s${i}: rumPageloadEventsAdaptiveGroups(limit:${zone ? 3000 : 600}, ` +
      `filter:{siteTag:"${s.siteTag}", date_geq:$start, date_leq:$end}, orderBy:[count_DESC])` +
      `{ count sum{visits} dimensions{date refererHost refererPath${zone ? " requestHost" : ""}} }`
    );
  });
  return `query($acc:String!,$start:Date!,$end:Date!){viewer{accounts(filter:{accountTag:$acc}){${parts.join(" ")}}}}`;
}

interface RumReferrerRow {
  count?: unknown;
  sum?: { visits?: unknown };
  dimensions?: { date?: unknown; requestHost?: unknown; refererHost?: unknown; refererPath?: unknown };
}

// Pure and exported, same reason as normalizeRum. Rows with no referrer
// (direct / typed-in / privacy-stripped) and rows whose referrer is the site
// itself (in-site navigation) are dropped: neither is an arrival from
// somewhere, and storing them would only put a meaningless "(direct)" row on
// every surface table. Several raw rows can fold into one label (bing.com with
// two different paths), so counts are summed per (site, date, label).
export function normalizeRumReferrers(payload: unknown, sites: SiteConfig[]): SiteReferrerDaily[] {
  if (typeof payload !== "object" || payload === null) return [];
  const accounts = (payload as { data?: { viewer?: { accounts?: unknown } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const acct = accounts[0] as Record<string, unknown>;

  const out = new Map<string, SiteReferrerDaily>();
  sites.forEach((site, i) => {
    const rows = acct[`s${i}`];
    if (!Array.isArray(rows)) return;
    for (const raw of rows as RumReferrerRow[]) {
      const date = raw?.dimensions?.date;
      if (typeof date !== "string") continue;
      const refHost = raw?.dimensions?.refererHost;
      if (typeof refHost !== "string" || refHost === "") continue;
      let host = site.host;
      if (isZoneSite(site)) {
        const rh = raw?.dimensions?.requestHost;
        if (typeof rh !== "string" || rh === "") continue;
        host = rh.toLowerCase();
      }
      const refPath = raw?.dimensions?.refererPath;
      const referrer = referrerLabel(refHost, typeof refPath === "string" ? refPath : null);
      if (referrer === host) continue;
      const key = `${host}\u0000${date}\u0000${referrer}`;
      const prev = out.get(key) ?? { site: host, date, referrer, pageviews: 0, visits: 0 };
      prev.pageviews += num(raw?.count);
      prev.visits += num(raw?.sum?.visits);
      out.set(key, prev);
    }
  });
  return [...out.values()];
}

// Same failure contract as fetchRumDaily: a GraphQL `errors` array or a missing
// alias throws rather than being read as "no referrers".
export async function fetchRumReferrers(
  sites: SiteConfig[],
  accountId: string,
  token: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchFn = fetch
): Promise<SiteReferrerDaily[]> {
  if (sites.length === 0) return [];
  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: buildReferrerQuery(sites),
      variables: { acc: accountId, start: startDate, end: endDate }
    })
  });
  if (!res.ok) throw new Error(`cloudflare rum referrers graphql ${res.status}`);
  const payload = await res.json<unknown>();
  const errors = (payload as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown };
    throw new Error(`cloudflare rum referrers error: ${typeof first?.message === "string" ? first.message : "unknown"}`);
  }
  const accounts = (payload as { data?: { viewer?: { accounts?: Record<string, unknown>[] } } }).data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1 ||
      sites.some((_, i) => !Array.isArray(accounts[0]?.[`s${i}`]))) {
    throw new Error("cloudflare rum referrers response missing account or site data");
  }
  return normalizeRumReferrers(payload, sites);
}
