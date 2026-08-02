import type {
  RepoDaily,
  ReferrerRow,
  Post,
  PostMetrics,
  SiteDaily,
  CheckResult,
  Todo,
  SourceRun
} from "./types";

export async function upsertRepoDaily(db: D1Database, rows: RepoDaily[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO repo_daily (repo, date, views, unique_views, clones, unique_clones, stars, forks)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT (repo, date) DO UPDATE SET
       views=excluded.views, unique_views=excluded.unique_views,
       clones=excluded.clones, unique_clones=excluded.unique_clones,
       stars=excluded.stars, forks=excluded.forks`
  );
  await db.batch(rows.map(r => stmt.bind(r.repo, r.date, r.views, r.uniqueViews, r.clones, r.uniqueClones, r.stars, r.forks)));
}

export async function upsertStarHistory(
  db: D1Database,
  repo: string,
  rows: { date: string; stars: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO star_history (repo, date, stars)
     VALUES (?1,?2,?3)
     ON CONFLICT (repo, date) DO UPDATE SET stars=excluded.stars`
  );
  await db.batch(rows.map(r => stmt.bind(repo, r.date, r.stars)));
}

export async function replaceReferrerSnapshot(
  db: D1Database,
  repo: string,
  capturedDate: string,
  rows: ReferrerRow[]
): Promise<void> {
  const stmts = [db.prepare(`DELETE FROM referrer_snapshot WHERE repo=?1 AND captured_date=?2`).bind(repo, capturedDate)];
  const ins = db.prepare(`INSERT INTO referrer_snapshot (repo, captured_date, referrer, count, uniques) VALUES (?1,?2,?3,?4,?5)`);
  for (const r of rows) stmts.push(ins.bind(repo, capturedDate, r.referrer, r.count, r.uniques));
  await db.batch(stmts);
}

// All rows from the repo's most-recently-captured snapshot date, ordered by
// count desc. Returns [] when the repo has no referrer_snapshot rows at all
// (the MAX(captured_date) subquery is NULL, so the outer equality matches
// nothing — no special-casing needed).
export async function getLatestReferrers(db: D1Database, repo: string): Promise<ReferrerRow[]> {
  const res = await db
    .prepare(
      `SELECT referrer, count, uniques FROM referrer_snapshot
       WHERE repo=?1 AND captured_date = (SELECT MAX(captured_date) FROM referrer_snapshot WHERE repo=?1)
       ORDER BY count DESC`
    )
    .bind(repo)
    .all<ReferrerRow>();
  return res.results;
}

export async function insertPost(db: D1Database, post: Post): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO posts (url, platform, project, title, published_at) VALUES (?1,?2,?3,?4,?5)`
    )
    .bind(post.url, post.platform, post.project, post.title, post.publishedAt)
    .run();
  return res.meta.last_row_id;
}

export async function listPosts(db: D1Database): Promise<Post[]> {
  const res = await db
    .prepare(
      `SELECT id, url, platform, project, title, published_at AS publishedAt FROM posts`
    )
    .all<Post>();
  return res.results;
}

export async function upsertPostMetrics(
  db: D1Database,
  postId: number,
  date: string,
  m: PostMetrics
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO post_metrics (post_id, date, views, replies, likes, score)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT (post_id, date) DO UPDATE SET
         views=excluded.views, replies=excluded.replies, likes=excluded.likes, score=excluded.score`
    )
    .bind(postId, date, m.views, m.replies, m.likes, m.score)
    .run();
}

export async function latestPostMetrics(
  db: D1Database,
  postId: number
): Promise<(PostMetrics & { date: string }) | null> {
  const row = await db
    .prepare(
      `SELECT date, views, replies, likes, score FROM post_metrics WHERE post_id=?1 ORDER BY date DESC LIMIT 1`
    )
    .bind(postId)
    .first<PostMetrics & { date: string }>();
  return row ?? null;
}

export async function upsertSiteDaily(db: D1Database, rows: SiteDaily[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO site_daily (site, date, pageviews, visitors)
     VALUES (?1,?2,?3,?4)
     ON CONFLICT (site, date) DO UPDATE SET
       pageviews=excluded.pageviews, visitors=excluded.visitors`
  );
  await db.batch(rows.map(r => stmt.bind(r.site, r.date, r.pageviews, r.visitors)));
}

// audit_results only ever holds the latest run's row per (project, check_id) —
// upsertAuditResults overwrites in place — so this is inherently "current state",
// not history. Ordered priority asc then check_id asc for a stable, deterministic
// listing (matches the priority-first ordering used elsewhere, e.g. getTopOpenTodos).
export async function listAuditResults(
  db: D1Database,
  project: string
): Promise<(CheckResult & { checkedAt: string })[]> {
  const res = await db
    .prepare(
      `SELECT check_id AS checkId, status, detail, priority, checked_at AS checkedAt
       FROM audit_results WHERE project=?1 ORDER BY priority ASC, check_id ASC`
    )
    .bind(project)
    .all<CheckResult & { checkedAt: string }>();
  return res.results;
}

// Sum of pageviews over the most recent `days` *recorded* dates (same "most
// recent N rows, not trailing N calendar days" semantics as getRepoSeries —
// see its comment). COALESCE guards the empty-table case: SUM() over zero
// rows is NULL, not 0.
export async function getSitePvSum(db: D1Database, days: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pageviews), 0) AS total FROM site_daily WHERE date IN (
         SELECT DISTINCT date FROM site_daily ORDER BY date DESC LIMIT ?1
       )`
    )
    .bind(days)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function upsertAuditResults(
  db: D1Database,
  project: string,
  results: CheckResult[],
  checkedAt: string
): Promise<void> {
  if (results.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO audit_results (project, check_id, status, detail, priority, checked_at)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT (project, check_id) DO UPDATE SET
       status=excluded.status, detail=excluded.detail, priority=excluded.priority, checked_at=excluded.checked_at`
  );
  await db.batch(results.map(r => stmt.bind(project, r.checkId, r.status, r.detail, r.priority, checkedAt)));
}

export async function insertTodoIfNew(db: D1Database, t: Todo): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO todos (project, source, title, priority, status, created_at)
       VALUES (?1,?2,?3,?4,?5, datetime('now'))`
    )
    .bind(t.project, t.source, t.title, t.priority, t.status)
    .run();
}

// Closes (status='open' -> 'done', done_at=doneAt) any open todo matching this
// exact (project, source, title) — a no-op UPDATE (0 rows affected) when no
// such open todo exists, so callers can call it unconditionally rather than
// checking existence first. Used by src/audit/run.ts to auto-close a todo
// whose underlying check now passes; relies on todoTitle (src/audit/checks.ts)
// being stable per (project, checkId) so the title matches the row an earlier
// failing run created via insertTodoIfNew.
export async function closeTodoByTitle(
  db: D1Database,
  project: string,
  source: Todo["source"],
  title: string,
  doneAt: string
): Promise<void> {
  await db
    .prepare(`UPDATE todos SET status='done', done_at=?4 WHERE status='open' AND project=?1 AND source=?2 AND title=?3`)
    .bind(project, source, title, doneAt)
    .run();
}

export async function setTodoStatus(
  db: D1Database,
  id: number,
  status: "open" | "done",
  doneAt: string | null
): Promise<void> {
  await db
    .prepare(`UPDATE todos SET status=?2, done_at=?3 WHERE id=?1`)
    .bind(id, status, doneAt)
    .run();
}

// done_at is selected (as doneAt) alongside the rest of the columns already
// returned here — it's always NULL for "open" rows, and populated for "done"
// rows by setTodoStatus. Task 12's todos page needs it to show when a done
// item was completed.
export async function listTodos(db: D1Database, status?: "open" | "done"): Promise<Todo[]> {
  const sql = status
    ? `SELECT id, project, source, title, priority, status, done_at AS doneAt FROM todos WHERE status=?1 ORDER BY id`
    : `SELECT id, project, source, title, priority, status, done_at AS doneAt FROM todos ORDER BY id`;
  const stmt = status ? db.prepare(sql).bind(status) : db.prepare(sql);
  const res = await stmt.all<Todo>();
  return res.results;
}

// Top N open todos ordered priority asc then created_at asc (oldest first
// within a priority tier) — the ordering `listTodos` doesn't provide since
// `Todo` carries no createdAt field for callers to sort by themselves.
export async function getTopOpenTodos(db: D1Database, limit: number): Promise<Todo[]> {
  const res = await db
    .prepare(
      `SELECT id, project, source, title, priority, status FROM todos
       WHERE status='open' ORDER BY priority ASC, created_at ASC LIMIT ?1`
    )
    .bind(limit)
    .all<Todo>();
  return res.results;
}

export async function upsertProjectChannel(
  db: D1Database,
  project: string,
  channelId: string,
  status: "posted" | "planned" | "na",
  postId: number | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_channels (project, channel_id, status, post_id, updated_at)
       VALUES (?1,?2,?3,?4, datetime('now'))
       ON CONFLICT (project, channel_id) DO UPDATE SET
         status=excluded.status, post_id=excluded.post_id, updated_at=excluded.updated_at`
    )
    .bind(project, channelId, status, postId)
    .run();
}

export async function listProjectChannels(
  db: D1Database
): Promise<{ project: string; channelId: string; status: string; postId: number | null }[]> {
  const res = await db
    .prepare(
      `SELECT project, channel_id AS channelId, status, post_id AS postId FROM project_channels`
    )
    .all<{ project: string; channelId: string; status: string; postId: number | null }>();
  return res.results;
}

export async function recordSourceRun(
  db: D1Database,
  source: string,
  ok: boolean,
  error?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_runs (source, last_run_at, ok, error)
       VALUES (?1, datetime('now'), ?2, ?3)
       ON CONFLICT (source) DO UPDATE SET
         last_run_at=excluded.last_run_at, ok=excluded.ok, error=excluded.error`
    )
    .bind(source, ok ? 1 : 0, error ?? null)
    .run();
}

export async function listSourceRuns(db: D1Database): Promise<SourceRun[]> {
  const res = await db
    .prepare(`SELECT source, last_run_at AS lastRunAt, ok, error FROM source_runs`)
    .all<{ source: string; lastRunAt: string; ok: number; error: string | null }>();
  return res.results.map(r => ({ source: r.source, lastRunAt: r.lastRunAt, ok: r.ok === 1, error: r.error }));
}

// `days` means "the most recent N recorded rows", not "trailing N calendar days" —
// filtering by wall-clock date would under-return when the daily cron misses a run,
// so we take the N latest dates present and sort them ascending for charting.
export async function getRepoSeries(db: D1Database, repo: string, days: number): Promise<RepoDaily[]> {
  const res = await db
    .prepare(
      `SELECT * FROM (
         SELECT repo, date, views, unique_views AS uniqueViews, clones, unique_clones AS uniqueClones, stars, forks
         FROM repo_daily WHERE repo=?1 ORDER BY date DESC LIMIT ?2
       ) ORDER BY date ASC`
    )
    .bind(repo, days)
    .all<RepoDaily>();
  return res.results;
}

export async function getStarSeries(db: D1Database, repo: string): Promise<{ date: string; stars: number }[]> {
  const res = await db
    .prepare(`SELECT date, stars FROM star_history WHERE repo=?1 ORDER BY date ASC`)
    .bind(repo)
    .all<{ date: string; stars: number }>();
  return res.results;
}
