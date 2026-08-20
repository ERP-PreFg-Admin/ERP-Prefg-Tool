-- WHAT: put the already-existing-but-dead `un_code_mfg_sku_wh_map` into service as
-- the manufacturer × facility × SKU catalog. Re-grains it from one row per
-- (facility, manufacturer) to one row per (facility, manufacturer, SKU), and adds
-- three nullable columns tracking Uniware push/confirmation state.
--
-- WHY: in Unicommerce a manufacturer is a VENDOR, and a vendor's item catalog is
-- scoped to a FACILITY — that is why the export script sends a different
-- `Facility` header for each of the 18 codes. Our `master_recipe_mfg(recipe_id,
-- mfg_id)` has no facility dimension at all, so "does this manufacturer make this
-- SKU at Bhiwandi under Kreative?" has no answer in this database.
--
-- Two live consequences, both of which this table was created for and never wired
-- to:
--   1. lib/invoice-inward.ts:382 sends `vendorCode: UNIWARE_VENDOR_CODE ||
--      mfgCode` — ONE env var for every manufacturer at every facility, defaulting
--      to 'Test_Vendor'. lib/env.ts:112-114 flags it: "MUST be overridden before
--      going live, or every PO lands against the test vendor."
--   2. The external export script carries a WANTED_VENDORS list, a MANUAL_ALIASES
--      dict and difflib fuzzy matching, purely because Uniware's vendor codes
--      differ per facility (KAPCO_INTERNATIONAL_ vs KAPCO_INTERNATIONAL, arovea vs
--      AROVEA_). Once this table is populated that guessing is deleted — matching
--      becomes an exact (facility_code, un_mfg_code) compare.
--
-- ROW GRAIN. One row per (mfg, facility, sku), with `un_mfg_code` REPEATED across
-- a pair's rows. That denormalisation is deliberate: it is exactly the shape of a
-- Vendor Item Master export row (vendorCode, facility, itemTypeSku all on one
-- line), so ingest is a straight upsert with no reshaping.
--
-- `sku_id IS NULL` is the meaningful case the nullable column was always for:
-- "this manufacturer IS a vendor at this facility, code X, no SKUs mapped yet."
-- That row is what separates a grey cell (not a vendor here — nothing can be
-- mapped, and no PO can carry a vendorCode) from a pink one (vendor here, nothing
-- mapped). See cellState() in app/po-tracking/mfg-overview/mapping-state.ts.
--
-- `wh_id` is details_warehouse_entity.id — a FACILITY (location × legal entity) —
-- NOT master_warehouse.id. 18 active rows as of 2026-08-19, which is the matrix's
-- column count.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no DROP INDEX IF EXISTS or ADD COLUMN IF NOT
-- EXISTS, so a second run fails on section 1 with "check that column/key exists".
-- Harmless, but it will not no-op.
--
-- SAFE TO RUN: verified 2026-08-19 that both mcaff_prefg_dev and mcaff_prefg_prod
-- hold this table with BOTH original unique keys and ZERO rows, so the index swap
-- cannot conflict with existing data and needs no backfill or dedupe.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync — note it
-- does not model this table at all today, so this is an addition there, not an edit.


-- ── 1. Pre-check. This must return 0 on both schemas before section 2. ────────
--
-- If it does not, the re-grain would have to dedupe first: the old uq_wh_mfg
-- allowed one row per pair, so any existing row is a vendor-code row that should
-- become sku_id IS NULL — which it already is, since sku_id was never written.
SELECT COUNT(*) AS existing_rows FROM un_code_mfg_sku_wh_map;

-- What the keys look like now, so the diff after section 2 is visible.
SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'un_code_mfg_sku_wh_map'
 GROUP BY INDEX_NAME, NON_UNIQUE;


-- ── 2. Re-grain: one row per (facility, mfg, SKU) ─────────────────────────────
--
-- Both keys being dropped are RIGHT for a vendor-code map and IMPOSSIBLE for a
-- SKU catalog:
--
--   uq_wh_mfg  (wh_id, mfg_id)      permits exactly ONE row per (facility,
--                                   manufacturer). The second SKU mapped for that
--                                   pair fails with ER_DUP_ENTRY.
--   uq_wh_code (wh_id, un_mfg_code) fails identically — every row for a pair
--                                   repeats that pair's un_mfg_code.
--
-- ⚠️ Dropping uq_wh_code REMOVES A REAL GUARD, and nothing at the database level
-- replaces it. It was the only thing stopping two of our manufacturers from
-- claiming the same Uniware vendor code at one facility — which would silently
-- inward one against the other's ledger. That check now lives in the route
-- (selectVendorCodeConflict in lib/queries/mfg-facility-map.ts) and is pinned by
-- tests/db/mfg-facility-map.test.ts. If that test is ever deleted, this hazard
-- comes back unguarded.
ALTER TABLE un_code_mfg_sku_wh_map
  DROP INDEX uq_wh_mfg,
  DROP INDEX uq_wh_code,
  ADD UNIQUE KEY uq_wh_mfg_sku (wh_id, mfg_id, sku_id),
  -- Was unique, still the lookup path: resolving an export row's
  -- (facility, vendorCode) back to a mfg_id runs on every ingested row.
  ADD KEY idx_wh_code (wh_id, un_mfg_code);

-- idx_wh (wh_id) is now redundant — uq_wh_mfg_sku and idx_wh_code both have wh_id
-- leftmost, and fk_map_wh is satisfied by either. Dropped rather than left to rot.
ALTER TABLE un_code_mfg_sku_wh_map DROP INDEX idx_wh;


-- ── 3. Push + confirmation state ──────────────────────────────────────────────
--
-- Three nullable columns, because "a user asked for this", "we successfully
-- created it in Uniware" and "Uniware's export confirms it exists" are three
-- INDEPENDENT facts. Collapsing them into one boolean deletes the reconciliation
-- report this feature exists to produce.
--
-- un_pushed_at and un_seen_at are NOT redundant:
--   • a row can exist in Uniware that we never pushed — every pre-existing
--     mapping, i.e. the entire seed case; and
--   • a row we pushed can later be deleted in Uniware, which only the export
--     catches.
--
-- Not folded into `remarks`: that is user-facing free text, so a sync would
-- overwrite whatever a human wrote there.
ALTER TABLE un_code_mfg_sku_wh_map
  ADD COLUMN un_pushed_at  DATETIME(0) NULL
    COMMENT 'Our vendor-item create returned success. NULL on a mapped row = needs a retry'
    AFTER sku_id,
  ADD COLUMN un_push_error VARCHAR(500) NULL
    COMMENT 'Last push failure, shown beside Retry in the drilldown panel. Cleared on success'
    AFTER un_pushed_at,
  ADD COLUMN un_seen_at    DATETIME(0) NULL
    COMMENT 'Last Vendor Item Master import that CONTAINED this row. Independent of un_pushed_at'
    AFTER un_push_error;


-- ── 4. Say what the table is, where SHOW CREATE TABLE will show it ────────────
-- The name reads "un code / mfg / sku / wh map" and undersells it; the comment is
-- the only place the grain is stated next to the data.
ALTER TABLE un_code_mfg_sku_wh_map
  COMMENT='Manufacturer x FACILITY x SKU catalog mirrored to Uniware. One row per (wh_id, mfg_id, sku_id); sku_id IS NULL = the vendor-code row, meaning this mfg is a Uniware vendor at this facility with no SKUs mapped yet. wh_id is details_warehouse_entity.id, NOT master_warehouse.id. un_mfg_code repeats across a pair''s rows on purpose - it mirrors a Vendor Item Master export row';

ALTER TABLE un_code_mfg_sku_wh_map
  MODIFY COLUMN wh_id INT NOT NULL
    COMMENT 'details_warehouse_entity.id — a FACILITY (location x legal entity)',
  MODIFY COLUMN un_mfg_code VARCHAR(100) NOT NULL
    COMMENT 'Uniware vendorCode AT THIS FACILITY. Differs per facility for the same manufacturer, which is why it is stored per row',
  MODIFY COLUMN sku_id INT NULL
    COMMENT 'master_skus.id. NULL = the vendor-code row for this (facility, mfg). Uniware sends itemTypeSku, matched to master_skus.sku_code';


-- ── 5. VERIFY ─────────────────────────────────────────────────────────────────

-- Expect uq_wh_mfg_sku (wh_id,mfg_id,sku_id) UNIQUE, idx_wh_code non-unique,
-- and NEITHER uq_wh_mfg NOR uq_wh_code.
SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'un_code_mfg_sku_wh_map'
 GROUP BY INDEX_NAME, NON_UNIQUE;

-- Expect un_pushed_at, un_push_error, un_seen_at present.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'un_code_mfg_sku_wh_map'
 ORDER BY ORDINAL_POSITION;

-- 18 as of 2026-08-19 — this is the matrix's column count.
SELECT COUNT(*) AS active_facilities FROM details_warehouse_entity WHERE status = 'active';

-- The re-grain's whole point: two SKUs for ONE (facility, mfg) must both survive.
-- Run inside a transaction and roll back — this is a check, not a fixture.
--   START TRANSACTION;
--   INSERT INTO un_code_mfg_sku_wh_map (mfg_id, wh_id, un_mfg_code, sku_id) VALUES
--     (1, 1, 'SELFTEST', (SELECT id FROM master_skus LIMIT 1)),
--     (1, 1, 'SELFTEST', (SELECT id FROM master_skus LIMIT 1 OFFSET 1));
--   SELECT COUNT(*) AS should_be_2 FROM un_code_mfg_sku_wh_map WHERE un_mfg_code = 'SELFTEST';
--   ROLLBACK;
