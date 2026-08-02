import type { SiteDaily } from "../types";
import type { FetchFn } from "./github";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";

interface GoatCounterStatEntry {
  day?: unknown;
  daily?: unknown;
  daily_unique?: unknown;
}

interface GoatCounterTotalResponse {
  stats?: unknown;
}

// GoatCounter's GET /api/v0/stats/total response shape is UNVERIFIED against
// the live API — assumed here from public docs as
// { total, total_events, stats: [{ day: "2026-08-01", daily: N, ... }] }.
// All field mapping is isolated in this pure function so that once Task 14/15
// validates the real response, only this function needs to change.
export function normalizeTotal(payload: unknown, site: string): SiteDaily[] {
  if (typeof payload !== "object" || payload === null) return [];
  const stats = (payload as GoatCounterTotalResponse).stats;
  if (!Array.isArray(stats)) return [];
  const result: SiteDaily[] = [];
  for (const entry of stats as GoatCounterStatEntry[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { day, daily, daily_unique } = entry;
    if (typeof day !== "string" || typeof daily !== "number") continue;
    // ASSUMPTION: the public docs do not confirm a per-day unique-visitor
    // field name; we guess `daily_unique` and default to 0 when it's absent
    // or not a number, so a missing field never crashes ingestion.
    const visitors = typeof daily_unique === "number" ? daily_unique : 0;
    result.push({ site, date: day, pageviews: daily, visitors });
  }
  return result;
}

export async function fetchSiteDaily(
  site: string,
  token: string,
  startDate: string,
  endDate: string,
  fetchFn: FetchFn = fetch
): Promise<SiteDaily[]> {
  const url = `https://${site}.goatcounter.com/api/v0/stats/total?start=${startDate}&end=${endDate}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT
    }
  });
  if (!res.ok) throw new Error(`goatcounter ${site} stats/total -> ${res.status}`);
  const payload = await res.json();
  return normalizeTotal(payload, site);
}
