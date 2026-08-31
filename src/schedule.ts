// Cron expressions, mirrored from wrangler.toml.
//
// wrangler.toml is the authority — the strings here must match it exactly, or
// the scheduled handler falls through to the wrong branch. They are duplicated
// because a Worker cannot read its own wrangler.toml at runtime, and routing on
// the cron string is the only way one Worker can tell its scheduled invocations
// apart.

// The cheap sources (github/posts/goatcounter/cloudflare/rum) all run together
// in one invocation; none of them scales with fleet size the way the audit does.
export const CHEAP_CRON = "0 1 * * *";

// The audit is sharded across these invocations — one shard each, in order.
// Every shard runs every day, so no project waits more than a day to be
// re-checked; the split exists purely to stay under the free tier's
// 50-subrequests-per-invocation cap.
//
// Growing the fleet eventually needs another entry here AND another cron in
// wrangler.toml. The test suite asserts the shard count never exceeds this
// list's length, so forgetting fails a test rather than silently leaving the
// tail of the fleet un-audited.
export const AUDIT_CRONS = ["30 1 * * *", "40 1 * * *"];
