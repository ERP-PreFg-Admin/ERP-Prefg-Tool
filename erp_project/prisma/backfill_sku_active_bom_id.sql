-- master_skus.active_bom_id was never actually written by application code
-- (only ever read, to resolve the SKU master list's bom_code column) — see
-- lib/queries/skus.ts's setActiveBomId/clearActiveBomIdIfMatches, now wired
-- into bomHandler.applyAndArchive, bomBulkHandler.applyAndArchive, and the
-- update-status action. Run this once to catch up existing data; new BOM
-- activations keep it in sync going forward.
UPDATE master_skus s
JOIN master_bom b ON b.sku_id = s.id AND b.status = 'active'
SET s.active_bom_id = b.id
WHERE s.active_bom_id IS NULL OR s.active_bom_id <> b.id;

-- Clear active_bom_id for any SKU whose current pointer references a BOM
-- that isn't (or no longer is) active.
UPDATE master_skus s
LEFT JOIN master_bom b ON b.id = s.active_bom_id AND b.status = 'active'
SET s.active_bom_id = NULL
WHERE s.active_bom_id IS NOT NULL AND b.id IS NULL;
