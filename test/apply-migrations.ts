import { applyD1Migrations, env } from "cloudflare:test";

// @ts-expect-error: TEST_MIGRATIONS is injected by vitest-pool-workers at runtime
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
