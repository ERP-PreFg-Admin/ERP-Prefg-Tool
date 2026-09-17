-- What: widen master_rm.inci_name from VARCHAR(50) to VARCHAR(1000).
--
-- Why:  an INCI name is a full ingredient list ("Aqua (and) Propylene glycol
--       (and) Rubus idaeus (raspberry) fruit extract ..."), routinely well over
--       50 characters. The column was the narrowest free-text field on the
--       table while `name` is VARCHAR(200) and `remarks` VARCHAR(300), which
--       reads as an oversight rather than a decision.
--
--       127 of 858 populated rows (15%) sit at exactly 50 characters and are
--       visibly cut mid-word — "Disodium EDT", "(and) Hydroly", "Sodium Cocoyl
--       Iset". MySQL truncated them silently because the instance runs without
--       STRICT_TRANS_TABLES.
--
--       BLOCKING: this must land BEFORE strict mode is enabled. Under strict
--       mode the same writes stop truncating and start failing outright —
--       verified against prod: a 78-character INCI name is rejected with
--       ER_DATA_TOO_LONG. Enabling strict mode first would break every RM save
--       carrying a realistic ingredient list.
--
--       The 127 already-truncated values are NOT recoverable — the tails were
--       never stored. They need re-entering from the supplier spec sheets.
--
-- Re-runnable: yes. Widening a column already at the target width is a no-op.
--
-- Run on BOTH schemas (dev and prod), and keep prisma/schema.prisma in sync.

ALTER TABLE master_rm
  MODIFY COLUMN inci_name VARCHAR(1000) NULL;

-- Verify: expect varchar(1000), and the at-max cluster to stop growing.
--
--   SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME = 'master_rm' AND COLUMN_NAME = 'inci_name';
--
--   SELECT COUNT(*) FROM master_rm WHERE CHAR_LENGTH(inci_name) = 50;
--   -- 127 today; these are the pre-existing truncations, not new ones.
