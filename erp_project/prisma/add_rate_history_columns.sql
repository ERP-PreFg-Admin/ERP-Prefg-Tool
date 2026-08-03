-- Adds `remarks` + `changed_by` to the rate-history archive tables so the
-- Rate History popup on RM/PM Cost Master (RmRateHistoryDialog/PmRateHistoryDialog)
-- can show who changed a rate and why, alongside the superseded rate value.
--
-- This is real MySQL 8.0 on RDS (not MariaDB, despite CLAUDE.md's description) —
-- MySQL does not support `ADD COLUMN IF NOT EXISTS`, so these are plain ALTERs.
-- No FK on changed_by (mirrors history_vrm/history_mrm's existing style of
-- loosely-typed archive rows) — join to `users` by id, tolerating NULL for
-- rows archived before this column existed.

ALTER TABLE history_vrm ADD COLUMN remarks    VARCHAR(300) NULL;
ALTER TABLE history_vrm ADD COLUMN changed_by INT          NULL;
ALTER TABLE history_mrm ADD COLUMN remarks    VARCHAR(300) NULL;
ALTER TABLE history_mrm ADD COLUMN changed_by INT          NULL;
