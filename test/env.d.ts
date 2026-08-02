declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_TOKEN: string;
    GITHUB_TOKEN: string;
  }
}
