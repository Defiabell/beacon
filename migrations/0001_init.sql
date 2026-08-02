CREATE TABLE repo_daily (
  repo TEXT NOT NULL, date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, unique_views INTEGER NOT NULL DEFAULT 0,
  clones INTEGER NOT NULL DEFAULT 0, unique_clones INTEGER NOT NULL DEFAULT 0,
  stars INTEGER NOT NULL DEFAULT 0, forks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, date)
);
CREATE TABLE star_history (
  repo TEXT NOT NULL, date TEXT NOT NULL, stars INTEGER NOT NULL,
  PRIMARY KEY (repo, date)
);
CREATE TABLE referrer_snapshot (
  repo TEXT NOT NULL, captured_date TEXT NOT NULL,
  referrer TEXT NOT NULL, count INTEGER NOT NULL, uniques INTEGER NOT NULL,
  PRIMARY KEY (repo, captured_date, referrer)
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE, platform TEXT NOT NULL,
  project TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT
);
CREATE TABLE post_metrics (
  post_id INTEGER NOT NULL, date TEXT NOT NULL,
  views INTEGER, replies INTEGER, likes INTEGER, score INTEGER,
  PRIMARY KEY (post_id, date)
);
CREATE TABLE site_daily (
  site TEXT NOT NULL, date TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0, visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date)
);
CREATE TABLE audit_results (
  project TEXT NOT NULL, check_id TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2, checked_at TEXT NOT NULL,
  PRIMARY KEY (project, check_id)
);
CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, done_at TEXT
);
CREATE UNIQUE INDEX todos_unique ON todos (project, source, title);
CREATE TABLE project_channels (
  project TEXT NOT NULL, channel_id TEXT NOT NULL,
  status TEXT NOT NULL, post_id INTEGER, updated_at TEXT NOT NULL,
  PRIMARY KEY (project, channel_id)
);
CREATE TABLE source_runs (
  source TEXT PRIMARY KEY, last_run_at TEXT NOT NULL,
  ok INTEGER NOT NULL, error TEXT
);
