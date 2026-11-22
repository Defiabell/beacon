import type { SourceName } from "./collect/run";

// Each minute retains its own invocation budget while sharing one trigger.
// Keep the minute list in sync with wrangler.toml.
export const COLLECT_CRON = "0,10,20,30,35,40,45,50,55 1 * * *";
// Three audit shards since the well-known-files check (2026-11-01) pushed the
// per-project cost to 12–13 subrequests: shard 0 is exactly 50, shard 2 has
// room for two more projects before a fourth minute is needed.
export const AUDIT_MINUTES: readonly number[] = [30, 40, 50];
// The page-level SEO audit (src/audit/page-run.ts), on the five-minute marks
// between the repo-audit shards: 21 pages at 6 subrequests worst case each
// (2026-11-22) is 8 + 8 + 5 pages, so the third slot has room for three more
// sites before a fourth minute is needed.
export const SEO_MINUTES: readonly number[] = [35, 45, 55];

// Previous expressions, accepted at their original slots while a trigger
// change propagates. The five-minute one carried audit shards 0/1 as well;
// the six-minute one all three audit shards and no SEO slots.
const LEGACY_COLLECT_CRONS = new Set(["0,10,20 1 * * *", "0,10,20,30,40 1 * * *", "0,10,20,30,40,50 1 * * *"]);
const COLLECT_GROUPS: Record<number, SourceName[]> = {
  0: ["github"],
  10: ["posts"],
  20: ["goatcounter", "cloudflare", "pages", "rum"]
};

// `auditShard` is the shard index for whichever audit the slot runs: the repo
// audit for an AUDIT_MINUTES slot, the page audit for a SEO_MINUTES slot.
export function scheduledCollection(cron: string, scheduledTime: number): { sources: SourceName[]; auditShard: number } {
  // Cloudflare delivers scheduledTime with a few seconds of jitter past the
  // minute (observed hh:mm:04 in production), so route on the containing
  // minute rather than demanding an exact :00.000 timestamp.
  const scheduled = new Date(Number.isFinite(scheduledTime) ? Math.floor(scheduledTime / 60000) * 60000 : NaN);
  const minute = scheduled.getUTCMinutes();
  const validTime = Number.isFinite(scheduledTime) && scheduledTime >= 0 && scheduled.getUTCHours() === 1;
  if (validTime) {
    // Accept the previous expressions during Cron Trigger propagation, but
    // only at their original UTC slots. Never route using actual start time.
    const auditShard = AUDIT_MINUTES.indexOf(minute);
    const legacyCoversMinute = LEGACY_COLLECT_CRONS.has(cron) && cron.split(" ")[0].split(",").includes(String(minute));
    if (auditShard >= 0 && (cron === COLLECT_CRON || legacyCoversMinute || cron === `${minute} 1 * * *`)) {
      return { sources: ["audit"], auditShard };
    }
    const seoShard = SEO_MINUTES.indexOf(minute);
    if (seoShard >= 0 && cron === COLLECT_CRON) return { sources: ["seo"], auditShard: seoShard };
    if (cron === COLLECT_CRON || legacyCoversMinute) {
      const sources = COLLECT_GROUPS[minute];
      if (sources) return { sources: [...sources], auditShard: 0 };
    }
  }
  // Never default an unrecognized schedule to an unbounded full-fleet run.
  throw new Error(`Unknown collection schedule: ${cron} at ${scheduledTime}`);
}
