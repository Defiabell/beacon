-- What the failing check found the last time it ran (the current value: which
-- URL, what length, which status). The title stays stable per (project, check)
-- because it is the todo's identity for dedup and auto-close, so the specifics
-- need a column of their own. NULL for manual and matrix todos.
ALTER TABLE todos ADD COLUMN detail TEXT;
