export interface Env {
  DB: D1Database;
  GITHUB_TOKEN: string;
  ADMIN_TOKEN: string;
  GOATCOUNTER_SITE?: string;   // GoatCounter site code，如 "defiabell"
  GOATCOUNTER_TOKEN?: string;
}
export type Platform = "v2ex" | "linuxdo" | "hn" | "reddit";
export interface RepoDaily { repo: string; date: string; views: number; uniqueViews: number; clones: number; uniqueClones: number; stars: number; forks: number; }
export interface ReferrerRow { referrer: string; count: number; uniques: number; }
export interface Post { id?: number; url: string; platform: Platform; project: string; title: string; publishedAt: string | null; }
export interface PostMetrics { views: number | null; replies: number | null; likes: number | null; score: number | null; }
export interface SiteDaily { site: string; date: string; pageviews: number; visitors: number; }
export interface CheckResult { checkId: string; status: "pass" | "fail" | "na"; detail: string; priority: 1 | 2 | 3; }
// doneAt is only ever populated when status is "done" (set by setTodoStatus);
// optional rather than required because getTopOpenTodos never selects it (its
// rows are always status="open", so it would always be undefined there).
export interface Todo { id?: number; project: string; source: "audit" | "matrix" | "manual"; title: string; priority: number; status: "open" | "done"; doneAt?: string | null; }
export interface SourceRun { source: string; lastRunAt: string; ok: boolean; error: string | null; }
