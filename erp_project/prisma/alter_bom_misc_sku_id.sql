-- WHAT: key bom_misc on (mfg, SKU, type) instead of (mfg, recipe, type); enforce one
-- live line per slot in the database; add status 'archived' for superseded prices,
-- which are kept as rows in bom_misc itself (no separate history table).
--
-- WHY: misc cost is the manufacturer's charge for a SKU and does not change with the
-- formulation, but a new recipe version started with none. See docs/misc-cost-by-sku-plan.md.
--
-- PRE-CHECK (must return no rows, or the UNIQUE index below fails):
--   SELECT bm.mfg_id, b.sku_id, bm.type, COUNT(*) FROM bom_misc bm
--   JOIN master_recipe b ON b.id = bm.bom_id WHERE bm.status IN ('active','in_review')
--   GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
-- Prod had 5 (Reve MCaf370, old recipe); those are set inactive first.
--
-- NOT RE-RUNNABLE: MySQL 8 has no ADD COLUMN IF NOT EXISTS. bom_id stays, now nullable,
-- so old code keeps working after this runs. Run on dev, then prod with its own go-ahead.

ALTER TABLE bom_misc ADD COLUMN sku_id INT NULL AFTER bom_id;

UPDATE bom_misc bm JOIN master_recipe b ON b.id = bm.bom_id SET bm.sku_id = b.sku_id;

ALTER TABLE bom_misc
  MODIFY COLUMN sku_id INT NOT NULL,
  MODIFY COLUMN bom_id INT NULL,
  MODIFY COLUMN status ENUM('active','inactive','discontinued','in_review','rejected','archived') COLLATE utf8mb4_unicode_ci DEFAULT 'active',
  ADD KEY idx_bom_misc_mfg_sku_type (mfg_id, sku_id, type),
  ADD CONSTRAINT fk_bom_misc_sku FOREIGN KEY (sku_id) REFERENCES master_skus (id);

-- One live line per (mfg, SKU, type). Non-live rows map to NULL, which UNIQUE ignores.
ALTER TABLE bom_misc
  ADD UNIQUE KEY uq_bom_misc_live_slot (
    (IF(status IN ('active', 'in_review'), CONCAT(mfg_id, ':', sku_id, ':', type), NULL))
  );
