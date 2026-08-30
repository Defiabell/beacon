-- Daily Cloudflare Worker request counts.
--
-- Deliberately a separate table from site_daily rather than reusing it with a
-- "worker:<name>" site key: site_daily's columns are pageviews/visitors, and a
-- Worker request is neither. One first-time load of the shotsync demo was
-- measured at 14 requests, so storing requests in a column named `pageviews`
-- would embed a ~14x error into every reader of that table.
CREATE TABLE worker_daily (
  script TEXT NOT NULL,
  date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  subrequests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script, date)
);
