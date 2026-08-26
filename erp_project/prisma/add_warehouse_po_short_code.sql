-- WHAT: two nullable columns on details_warehouse_entity — `po_short_code`, the
-- facility's segment in the Uniware PO code the ERP will mint, and
-- `po_seq_seed`, the cutover number that series starts counting from. Plus a
-- UNIQUE key on (entity_id, po_short_code).
--
-- WHY: the ERP currently sends NO purchaseOrderCode when it creates a Uniware PO
-- (lib/uniware/po-builder.ts:71), on the documented expectation that the
-- facility's own series would number it. It does not. Probing the live tenant
-- shows every ERP-created PO lands in a SEPARATE api-channel series —
-- MMUM2/2627/API/0001, HAHMD/2627/API/0006, KOL2/2627/API/0002 — so an
-- ERP-raised PO is visually foreign in the warehouse's own PO list.
--
-- Matching each site's own convention is not viable: the same probing showed
-- every facility's format is REDESIGNED each April, four generations in three
-- years for one site (mChyd2/PO0012 -> SR/Hyd2/PO0001 ->
-- SR/M/HYD2/2526/PO0001 -> M/HYD/PO/2627/0001), and the tenant grew from 6 to 18
-- facilities over the same period. So the ERP takes ONE uniform format of its
-- own and stores only the per-facility segment:
--
--     <letter> / <po_short_code> / <FY> / <serial>
--        M     /      MUM1       / 2627 /  01234
--
-- Only po_short_code is configured. The letter is derived from the legal entity
-- (PEP -> M, KREATIVE -> H, lib/constants.ts) so it cannot drift between the two
-- rows of one site, and the FY token is derived from the date, so April needs no
-- data entry. Two Mumbai locations are MUM1 / MUM2; one site under both entities
-- is M/MUM1 and H/MUM1, which is why the code hangs off this table and not off
-- master_warehouse.
--
-- ON po_seq_seed: the serial is (facility, FY)-scoped and restarts each April,
-- but it must not start at 1 at CUTOVER — that would look like a brand-new
-- operation. Set this once per facility from the site's live high-water serial
-- (`python check_uniware_apis/po_grn.py --report --days 30` prints it as `last=`)
-- and the first ERP code is seed + 1.
--
-- ON NULL: a facility with no po_short_code is NOT an error — it keeps today's
-- behaviour exactly, sending no code and letting Uniware number the PO. That is
-- what makes a newly added facility safe, and it is also how a single-site pilot
-- runs with no feature flag. Six facilities were added in the nine months to
-- Aug 2026, so "not configured yet" is a routine state, not an edge case.
--
-- ON THE UNIQUE KEY: two facilities of one entity sharing a short code would
-- share a serial series and mint colliding codes. MySQL treats NULLs as DISTINCT
-- in a unique index, so this constrains the configured rows while leaving any
-- number of unconfigured ones alone. Note this is the INVERSE of the trap in
-- lib/queries/mfg-facility-map.ts:36-38, where NULL-distinctness DEFEATED a
-- unique key — here it is precisely what makes one usable.
--
-- Both columns are additive and nullable, the same argument
-- prisma/add_warehouse_entity_gst_split.sql:22-28 makes for the `type` override.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, and ADD UNIQUE KEY
-- fails once the key exists.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_entity_gst_split.sql to have run first.


-- ── 1. Pre-flight: read this before running anything ─────────────────────────
-- Expect 18 active facilities, 9 per entity, and neither column present yet. If
-- either column IS listed, this file has already run — stop.
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'details_warehouse_entity'
   AND COLUMN_NAME IN ('po_short_code', 'po_seq_seed');

SELECT e.code AS entity, COUNT(*) AS facilities,
       SUM(dwe.facility_code IS NOT NULL AND dwe.facility_code <> '') AS with_facility
  FROM details_warehouse_entity dwe
  JOIN master_entity e ON e.id = dwe.entity_id
 WHERE dwe.status = 'active'
 GROUP BY e.code;


-- ── 2. The columns ───────────────────────────────────────────────────────────
ALTER TABLE details_warehouse_entity
  ADD COLUMN po_short_code VARCHAR(12) NULL
    COMMENT 'This facility''s segment in the ERP-minted Uniware PO code: <letter>/<this>/<FY>/<serial>. Upper-case, no separators. NULL = not configured, Uniware numbers the PO as it does today'
    AFTER facility_code,
  ADD COLUMN po_seq_seed INT NULL
    COMMENT 'Cutover seed for the serial. First ERP code is this + 1. Set once from the site''s live high-water serial so the series does not restart at 1. NULL = start at 1'
    AFTER po_short_code,
  ADD UNIQUE KEY uq_dwe_po_short_code (entity_id, po_short_code);


-- ── 3. Seeding (OPTIONAL — leave empty to keep every facility on today's
--       behaviour, and configure one site first as a pilot) ──────────────────
-- Short codes are yours to choose; these are the shape, not a recommendation.
-- Run `python check_uniware_apis/po_grn.py --report --days 30` and use each
-- facility's `last=` serial as its po_seq_seed.
--
-- UPDATE details_warehouse_entity dwe
--   JOIN master_warehouse w ON w.id = dwe.warehouse_id
--   JOIN master_entity    e ON e.id = dwe.entity_id
--    SET dwe.po_short_code = 'MUM2', dwe.po_seq_seed = 5651
--  WHERE w.name = 'Mumbai' AND e.code = 'PEP';


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Both columns present, both nullable.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'details_warehouse_entity'
   AND COLUMN_NAME IN ('po_short_code', 'po_seq_seed');

-- The unique key exists and spans exactly (entity_id, po_short_code).
SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'details_warehouse_entity'
   AND INDEX_NAME = 'uq_dwe_po_short_code'
 ORDER BY SEQ_IN_INDEX;

-- Must return zero rows: a short code that is not upper-case alphanumeric would
-- put a separator or a space inside a PO code segment. The route's Zod schema
-- enforces this on write; this catches anything seeded by hand in section 3.
SELECT dwe.id, e.code AS entity, dwe.po_short_code
  FROM details_warehouse_entity dwe
  JOIN master_entity e ON e.id = dwe.entity_id
 WHERE dwe.po_short_code IS NOT NULL
   AND dwe.po_short_code NOT REGEXP '^[A-Z0-9]{2,12}$';

-- Must return zero rows: a seed without a short code numbers nothing, and is
-- almost always a half-finished edit.
SELECT id, warehouse_id, entity_id, po_seq_seed
  FROM details_warehouse_entity
 WHERE po_seq_seed IS NOT NULL AND (po_short_code IS NULL OR po_short_code = '');
