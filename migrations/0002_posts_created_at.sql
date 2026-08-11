-- Adds a creation timestamp to posts so the impact engine (src/impact/) has
-- something to attribute against when published_at is NULL (e.g. live id=2,
-- shotsync's V2EX post, was inserted with no publishedAt at all — with no
-- timestamp of any kind that post cannot be attributed).
--
-- SQLite's ALTER TABLE ADD COLUMN rejects a non-constant default (datetime('now')
-- included), so this uses an empty-string placeholder and backfills it in a
-- second statement. New rows never see the placeholder — src/db.ts's insertPost
-- writes created_at explicitly on every insert going forward.
ALTER TABLE posts ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

UPDATE posts SET created_at = COALESCE(published_at, '2026-08-09') WHERE created_at = '';

-- One-time data fix: live id=2 (shotsync's V2EX post) has published_at = NULL,
-- i.e. no timestamp of any kind pre-migration. 2026-08-09 is its actual
-- publish date (see design doc), backfilled here rather than left NULL.
UPDATE posts SET published_at = '2026-08-09' WHERE id = 2 AND published_at IS NULL;
