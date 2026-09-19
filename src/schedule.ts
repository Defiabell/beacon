import type { SourceName } from "./collect/run";

// Each minute retains its own invocation budget while sharing one trigger.
// Keep the minute list in sync with wrangler.toml.
export const COLLECT_CRON = "0,10,20,30,40 1 * * *";
export const AUDIT_MINUTES: readonly number[] = [30, 40];

const LEGACY_COLLECT_CRON = "0,10,20 1 * * *";
const COLLECT_GROUPS: Record<number, SourceName[]> = {
  0: ["github"],
  10: ["posts"],
  20: ["goatcounter", "cloudflare", "pages", "rum"]
};

export function scheduledCollection(cron: string, scheduledTime: number): { sources: SourceName[]; auditShard: number } {
  const scheduled = new Date(scheduledTime);
  const minute = scheduled.getUTCMinutes();
  const validTime = Number.isFinite(scheduledTime) && scheduled.getUTCHours() === 1 &&
    scheduled.getUTCSeconds() === 0 && scheduled.getUTCMilliseconds() === 0;
  if (validTime) {
    // Accept the previous expressions during Cron Trigger propagation, but
    // only at their original UTC slots. Never route using actual start time.
    const auditShard = AUDIT_MINUTES.indexOf(minute);
    if (auditShard >= 0 && (cron === COLLECT_CRON || cron === `${minute} 1 * * *`)) {
      return { sources: ["audit"], auditShard };
    }
    if (cron === COLLECT_CRON || cron === LEGACY_COLLECT_CRON) {
      const sources = COLLECT_GROUPS[minute];
      if (sources) return { sources: [...sources], auditShard: 0 };
    }
  }
  // Never default an unrecognized schedule to an unbounded full-fleet run.
  throw new Error(`Unknown collection schedule: ${cron} at ${scheduledTime}`);
}
