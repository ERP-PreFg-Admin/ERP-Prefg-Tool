-- WHAT: users.whats_new_seen — the release whose "What's new" popup this user has dismissed.
-- NULL = never dismissed one, so the next release with notes shows. See docs/whats-new-popup-plan.md.
--
-- NOT RE-RUNNABLE: MySQL 8 has no ADD COLUMN IF NOT EXISTS. Run on dev, then prod with its own go-ahead,
-- BEFORE the deploy that reads the column.

ALTER TABLE users
  ADD COLUMN whats_new_seen VARCHAR(20) NULL;
