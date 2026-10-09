-- What: users.welcome_sent_at — when the ERP's welcome mail last went to this user.
-- Why:  the welcome mail is sent on create (if active) or on first activation, and an
--       admin can resend it; this is what the Users table shows. See docs/welcome-mail-plan.md.
-- Existing users stay NULL — no backfill, and nobody existing is mailed.
-- Re-runnable: NO (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
-- Run on dev first; prod on its own go-ahead, BEFORE the deploy.

ALTER TABLE users ADD COLUMN welcome_sent_at DATETIME NULL AFTER created_at;
