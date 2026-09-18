import type { SourceName } from "./collect/run";

// A minute list gives each group its own invocation without consuming extra
// account-level Cron Trigger slots. Keep this expression in wrangler.toml.
export const COLLECT_CRON = "0,10,20 1 * * *";
export const AUDIT_CRONS = ["30 1 * * *", "40 1 * * *"];

const COLLECT_GROUPS: Record<number, SourceName[]> = {
  0: ["github"],
  10: ["posts"],
  20: ["goatcounter", "cloudflare", "pages", "rum"]
};

export function scheduledCollection(cron: string, scheduledTime: number): { sources: SourceName[]; auditShard: number } {
  const auditShard = AUDIT_CRONS.indexOf(cron);
  if (auditShard >= 0) return { sources: ["audit"], auditShard };
  if (cron === COLLECT_CRON) {
    const sources = COLLECT_GROUPS[new Date(scheduledTime).getUTCMinutes()];
    if (sources) return { sources: [...sources], auditShard: 0 };
  }
  // Never default an unrecognized schedule to an unbounded full-fleet run.
  throw new Error(`Unknown collection schedule: ${cron} at ${scheduledTime}`);
}
