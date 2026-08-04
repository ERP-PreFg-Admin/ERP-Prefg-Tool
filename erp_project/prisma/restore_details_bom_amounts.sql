-- details_bom: restore formulation amounts lost when the table was rebuilt.
--
-- Companion to fix_details_bom_columns.sql. That one restored the column names;
-- this one restores the values, which the rebuild had also zeroed — all 14
-- details_bom rows held 0.0000 while history_bom (the approval snapshot written
-- by the same flow, never rebuilt) still held the real figures.
--
-- Matched on (bom_id, mtrl_type, mtrl_id) — the natural key for a BOM line.
-- Only zeroed rows are touched, so re-running this can never overwrite an
-- amount someone has since re-entered by hand.
--
-- Recovers boms 1 and 6 only; boms 2/3/4/5 have no history_bom snapshot and
-- must be re-entered through the BOM editor.
--
-- Applied to mcaff_prefg_dev on 2026-08-04.

UPDATE details_bom db
  INNER JOIN history_bom h
     ON h.bom_id    = db.bom_id
    AND h.mtrl_type = db.mtrl_type
    AND h.mtrl_id   = db.mtrl_id
   SET db.amount = h.amount
 WHERE db.amount = 0
   AND h.amount <> 0;

