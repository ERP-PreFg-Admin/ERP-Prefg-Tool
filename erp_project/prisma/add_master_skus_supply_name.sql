-- What: add master_skus.supply_name, the SKU's name for supply/PO purposes.
--
-- Why:  `name` is the Uniware/DWH name and is overwritten by
--       scripts/sync-skus-from-dwh.ts, so a user-maintained name needs its own
--       column the sync never touches. Edited only through the SKU approval flow.
--
-- Re-runnable: NO (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
--
-- Run on BOTH schemas (dev first, prod on its own go-ahead), and keep
-- prisma/schema.prisma in sync. Must land before the code that selects it.

ALTER TABLE master_skus
  ADD COLUMN supply_name VARCHAR(500) NULL AFTER name;

-- Verify:
--   SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME = 'master_skus' AND COLUMN_NAME = 'supply_name';
