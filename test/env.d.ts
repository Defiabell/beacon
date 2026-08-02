declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    ADMIN_TOKEN: string;
    GITHUB_TOKEN: string;
  }
}

// Vite's `?raw` import suffix inlines the target file's contents as a string
// at build time; used by audit tests to load fixture markdown as plain text.
declare module "*?raw" {
  const content: string;
  export default content;
}
