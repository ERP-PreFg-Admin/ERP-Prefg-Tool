-- What: rate-history archives gain approved_by + submitted_on, so Rate History can show
--       "Uploaded by" and "Approved by" with times. updated_on stays the approval time.
-- Why:  only the submitter (changed_by) was recorded. See docs/master-history-audit-plan.md.
-- Re-runnable: NO (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
-- Run on dev first; prod on its own go-ahead, BEFORE the deploy that writes these columns.
-- Rows archived before this keep NULL in both.

ALTER TABLE history_cost_mfg
  ADD COLUMN approved_by  INT      NULL AFTER changed_by,
  ADD COLUMN submitted_on DATETIME NULL AFTER approved_by;

ALTER TABLE history_cost_ven
  ADD COLUMN approved_by  INT      NULL AFTER changed_by,
  ADD COLUMN submitted_on DATETIME NULL AFTER approved_by;
