-- WHAT: widen `mtrl_type` from ENUM('rm','pm') to ENUM('rm','pm','sku') on both
-- `details_recipe` and `history_recipe`.
--
-- WHY: a gift kit is not manufactured from raw material, it is ASSEMBLED FROM
-- OTHER SKUs. Seven SKUs carry sku_type='Gift Kit'; the six real ones are
-- subcategory='Kit' with filling_uom='units', where master_skus.filling is the
-- COMPONENT COUNT (Body Bliss Discovery Gift Set = 7 units). Recipe Master could
-- not describe one at all: create-full demands at least one RM line and that the RM
-- percentages total 99.5-100.5%, so no gift kit has ever had a recipe.
--
-- A third line type is the smallest change that fits the existing model. A recipe
-- line is already (mtrl_type, mtrl_id) where mtrl_id's MEANING depends on the type
-- and there is no FK — 'rm' means master_rm.id, 'pm' means master_pm.id. 'sku'
-- means master_skus.id, with `amount` = the unit count and `uom` = 'units'.
--
-- ROW GRAIN is unchanged: still one row per (recipe_id, mtrl_type, mtrl_id).
--
-- ⚠️ COSTING DELIBERATELY IGNORES 'sku' LINES. Every costing path branches
-- `mtrl_type === 'rm' ? rmCost : pmCost`, so a component SKU would fall into the PM
-- branch, miss the PM rate map and price at zero — the same silent-zero failure
-- CLAUDE.md records for bom_misc's bom_id alias. The application code that reads
-- details_recipe for costing now filters `mtrl_type IN ('rm','pm')` explicitly, so
-- a kit reads as UNCOSTED rather than as costing zero. Rolling component costs up
-- into the kit is a separate, deliberate change.
--
-- NOT RE-RUNNABLE in the "harmless" sense: MODIFY COLUMN is idempotent in effect
-- (running it twice leaves the same definition), but it rewrites the table, so do
-- not run it casually on a large table. details_recipe is small.
--
-- RUN ON BOTH SCHEMAS (mcaff_prefg_dev and mcaff_prefg_prod) and keep
-- prisma/schema.prisma in sync — the enum lives there as `details_bom_mtrl_type`
-- and `history_bom_mtrl_type`, still under the pre-2026-08 table names.
--
-- REVERSAL: narrowing back to ENUM('rm','pm') is safe ONLY while no 'sku' rows
-- exist; MySQL would otherwise coerce them to '' and silently strip every kit's
-- contents. Delete the kit recipes first.

ALTER TABLE details_recipe
  MODIFY COLUMN mtrl_type ENUM('rm', 'pm', 'sku') NOT NULL;

ALTER TABLE history_recipe
  MODIFY COLUMN mtrl_type ENUM('rm', 'pm', 'sku') NOT NULL;
