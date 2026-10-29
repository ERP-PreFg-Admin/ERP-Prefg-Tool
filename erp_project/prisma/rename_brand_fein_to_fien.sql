-- Rename brand Fein -> Fien (Ajay, 2026-10-28). Fien is the brand's own spelling and what the DWH
-- sends, so the DWH SKU sync stops writing text that matches no brand. Re-runnable.
-- Applied by script with a history_masters_edits row per SKU; this file is the record.
-- PO numbering is unchanged: lib/constants.ts maps both spellings to MCAFF. po_code 'FEIN' is a label only.

UPDATE master_brand SET brand_key = 'fien', name = 'Fien' WHERE id = 2 AND brand_key = 'fein';
UPDATE master_skus SET brand = 'Fien' WHERE brand_id = 2 AND brand <> 'Fien';

-- Verify: expect no rows.
SELECT id, sku_code, brand FROM master_skus WHERE brand_id = 2 AND brand <> 'Fien';
