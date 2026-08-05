-- details_bom: restore the column contract the application expects.
--
-- The live table had drifted to:
--   id, bom_id, mtrl_type, mtrl_id, mtrl_amount, uom, updated_on, status, updated_by
--
-- while lib/queries/bom.ts, lib/queries/manufacturing.ts,
-- lib/approvals/handlers/bom.ts and prisma/schema.prisma all read/write
-- `amount`, `effective_from`, `effective_till` and `last_updated`. Every BOM
-- master, costing and BOM-approval query failed with ER_BAD_FIELD_ERROR
-- ("Unknown column 'db.amount' in 'field list'") until this ran.
--
-- The sibling history_bom table — which the approval flow snapshots details_bom
-- into — never drifted and already carries amount/effective_from/effective_till/
-- last_updated. This brings details_bom back in line with it.
--
-- Data safety: both renames are CHANGE, so values are preserved; the two added
-- columns are nullable and land NULL on existing rows. Widening amount from
-- DECIMAL(10,2) to DECIMAL(12,4) matters because RM lines store a formulation
-- percentage that two decimal places would round (see selectMaterialCostByMfg).
-- At the time of writing all 14 rows held 0.00, so nothing was rounded already.

ALTER TABLE details_bom
  CHANGE COLUMN mtrl_amount amount DECIMAL(12, 4) NOT NULL,
  ADD    COLUMN effective_from DATE NULL AFTER uom,
  ADD    COLUMN effective_till DATE NULL AFTER effective_from,
  CHANGE COLUMN updated_on last_updated
         TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         AFTER effective_till;
