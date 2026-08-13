-- WHAT: add the legal-entity dimension to warehouses. Creates master_entity (our
-- own companies), adds state/status/created_by/updated_at + a UNIQUE name to
-- master_warehouse, and creates details_warehouse_entity — one row per
-- (location, legal entity) holding that entity's Unicommerce facility code, GST
-- registration and bill-to/ship-to addresses.
--
-- WHY: a warehouse is not owned by one entity. Every location operates under
-- BOTH Pep Technologies and Kreative Beauty, each with a DIFFERENT Unicommerce
-- facility — GGN MW is HYP_B2B_GGN under Kreative and GGN_WAREHOUSE under Pep.
-- master_warehouse had no way to express that, so lib/uniware.ts sent one global
-- UNIWARE_FACILITY env var as the Facility header on every call and every inward
-- PO landed in the same facility regardless of destination or of who was billed.
--
-- master_entity carries `pan`, not `gstin`: one entity holds several GST
-- registrations, one per state, and lib/gstin.ts panOf() already treats the PAN
-- as the entity identity. The per-state registration belongs on the child row.
-- OUR_PANS in lib/gstin.ts stays the source of truth for invoice detection — it
-- covers 9 registrations across 4 PANs and is deliberately broader than this
-- table. Do NOT rewire isOurs() off master_entity: it would start treating our
-- own out-of-state GSTINs as a supplier's.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, so section 4 fails
-- on a second run even though the CREATE TABLE IF NOT EXISTS sections do not.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Statement order below is required: master_entity must exist and be populated
-- before section 5 adds a foreign key to it.
--
-- Followed by prisma/backfill_warehouse_data.sql, which loads the real rows.


-- ── 1. Pre-checks. Read both before running anything below. ──────────────────

-- Duplicate names. The UNIQUE index in section 4 silently merges two
-- warehouses' POs, invoices and mail recipients if duplicates already exist,
-- so this must return zero rows first.
SELECT name, COUNT(*) c FROM master_warehouse GROUP BY name HAVING c > 1;

-- master_warehouse predates the migration files and has no explicit collation,
-- so check what it actually uses: the UNIQUE index inherits it, and that decides
-- whether 'Mumbai' and 'mumbai' are one name or two. A _ci collation — the usual
-- case, and what we want — means case-insensitive.
SELECT TABLE_COLLATION FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_warehouse';


-- ── 2. Our own legal entities ────────────────────────────────────────────────
--
-- ⚠️ master_entity ALREADY EXISTS on mcaff_prefg_dev, created by hand on
-- 2026-08-12 with no migration file and no code reading it. Its columns were
-- `name` / `short_name` rather than `legal_name` / `code`. Check which shape a
-- schema has BEFORE running this section:
--
--   SELECT COLUMN_NAME FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_entity';
--
--   - no rows          → the table is absent; run 2a, skip 2b.
--   - name/short_name  → the hand-made shape; skip 2a (IF NOT EXISTS would
--                        silently no-op and leave section 3 to fail), run 2b.
--   - legal_name/code  → already reconciled; skip both.
--
-- No `updated_at`: nothing edits an entity, and adding one is a one-line INSERT.
-- No approval module either — 4 rows at most. `status` is carried because the
-- hand-made table had it; it is unused today but harmless, and dropping a
-- populated column to match a design is the wrong way round.
--
-- COLLATE is explicit, unlike the older migrations that let it default —
-- prisma/fix_master_skus_collation.sql is a 63-line post-mortem of that drift.
--
-- utf8mb4_0900_ai_ci throughout, matching master_warehouse. The hand-made
-- master_entity on dev was utf8mb4_unicode_ci, i.e. the two disagreed, and 2b
-- converts it. This is not cosmetic: prisma/backfill_warehouse_data.sql joins a
-- UNION ALL derived table against BOTH master_entity.code and
-- master_warehouse.name. A bare literal is COERCIBLE and adopts the column's
-- collation, but once UNION ALL materialises the derived table its columns are
-- IMPLICIT like any column — and comparing two IMPLICIT columns of different
-- collations raises "Illegal mix of collations" rather than working.

-- 2a. Fresh schema only. Column types mirror the dev table exactly so the two
--     schemas cannot drift.
CREATE TABLE IF NOT EXISTS master_entity (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(50)  NOT NULL COMMENT 'Short internal code, UPPERCASE — PEP | KREATIVE',
  legal_name VARCHAR(150) NOT NULL COMMENT 'Name as registered; what an invoice prints',
  pan        VARCHAR(10)  NULL     COMMENT 'Entity identity — see lib/gstin.ts panOf(). Overlaps OUR_PANS, which stays authoritative for invoice detection',
  status     ENUM('active','inactive') NULL DEFAULT 'active',
  created_at TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_master_entity_code       (code),
  UNIQUE KEY uq_master_entity_pan        (pan),
  UNIQUE KEY uq_master_entity_legal_name (legal_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2b. Existing hand-made table only.
--
-- RENAME COLUMN (MySQL 8.0+) leaves type, nullability and default exactly as
-- they were, so there is nothing to restate and nothing to get wrong.
ALTER TABLE master_entity
  RENAME COLUMN name       TO legal_name,
  RENAME COLUMN short_name TO code;

-- The code is compared in TypeScript as well as in SQL — entityForBrand() in
-- lib/constants.ts returns "PEP" / "KREATIVE" — and a TS comparison is
-- case-sensitive even where a _ci collation forgives it. The hand-made rows read
-- 'PEP' but 'Kreative', so normalise.
--
-- No WHERE clause, deliberately. `WHERE code <> UPPER(code)` looks like the
-- idempotency guard but is a permanent no-op here: under utf8mb4_0900_ai_ci the
-- comparison is case-INsensitive, so 'Kreative' <> 'KREATIVE' is false and the
-- UPDATE matches nothing. UPPER() is idempotent anyway, and this is two rows.
UPDATE master_entity SET code = UPPER(code);

-- Converge on master_warehouse's collation. See the note above for why a
-- mismatch here is a hard error in the data load rather than a style issue.
-- Rebuilds the table and its indexes; instant at 2 rows.
ALTER TABLE master_entity CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- RENAME COLUMN carries the old indexes over under their old NAMES, so the
-- hand-made uniques are now called `short_name` (on code) and `name` (on
-- legal_name) and describe columns that no longer exist. `short_name` is also a
-- straight duplicate of uq_master_entity_code, which was added alongside it.
ALTER TABLE master_entity
  DROP INDEX   short_name,
  RENAME INDEX name TO uq_master_entity_legal_name;

-- Only if SHOW INDEX FROM master_entity does not already list them — a duplicate
-- key name errors. Both matter: ON DUPLICATE KEY UPDATE in section 3 needs a
-- unique key to match on, and `e.pan = ?` runs on every invoice inward via
-- warehouse.facilityByDestinationAndPan.
ALTER TABLE master_entity
  ADD UNIQUE KEY uq_master_entity_code (code),
  ADD UNIQUE KEY uq_master_entity_pan  (pan);


-- ── 3. Seed the two known entities ───────────────────────────────────────────
-- Idempotent, and a no-op on dev where these two rows already exist with these
-- exact PANs. lib/gstin.ts OUR_PANS also lists AAFCD3098K and ABGCS1450A;
-- neither is identified yet, so they are deliberately absent rather than
-- guessed — this table being narrower than OUR_PANS is expected, not a gap.
INSERT INTO master_entity (code, legal_name, pan) VALUES
  ('PEP',      'Pep Technologies Pvt Ltd', 'AAICP2804J'),
  ('KREATIVE', 'Kreative Beauty Pvt Ltd',  'AAJCK9697F')
ON DUPLICATE KEY UPDATE legal_name = VALUES(legal_name), pan = VALUES(pan);


-- ── 4. master_warehouse: the columns it never had ────────────────────────────
-- `state` is NOT the same as `zone`. zone is a region — North/South/West/
-- North East/East, the fixed set in components/masters/field-config.ts
-- ZONE_OPTIONS — while state is the Indian state, which is what a GSTIN's
-- leading two digits encode.
--
-- `status` carries all four values because the approval flow needs in_review
-- (locked) and rejected (re-editable by the submitter). Existing rows default
-- to active.
ALTER TABLE master_warehouse
  ADD COLUMN state      VARCHAR(50) NULL COMMENT 'Indian state. Distinct from `zone`, which is a region — see ZONE_OPTIONS' AFTER zone,
  ADD COLUMN status     ENUM('active','inactive','in_review','rejected') NOT NULL DEFAULT 'active',
  ADD COLUMN created_by INT NULL,
  ADD COLUMN updated_at DATETIME(0) NULL ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY uq_warehouse_name (name);

-- Document the pre-existing type column: CWH reads as "Central" but means Child.
-- Same ENUM values and same NOT NULL, so this only attaches a comment — but it
-- IS a table rewrite, which is free at ~11 rows and would not be on a big table.
-- Restating the values verbatim also avoids the ENUM-coercion trap in CLAUDE.md.
ALTER TABLE master_warehouse
  MODIFY COLUMN type ENUM('CWH','MWH') NOT NULL
    COMMENT 'MWH = Mother Warehouse (GGN MW, Mumbai) — receive from manufacturers. CWH = Child Warehouse — regional, fed from a mother';


-- ── 5. One row per (location, legal entity) ──────────────────────────────────
-- Keyed by entity, not brand: Fein and mCaffeine are both Pep and share one
-- facility, so this is 2 rows per location and Fein needs no schema change.
--
-- bill_to_* repeats across a given entity's rows — Kreative bills to its Mumbai
-- HO regardless of where the goods ship. Denormalised on purpose: ~20 rows of
-- repetition is cheaper than a third table.
--
-- Only fk_dwe_warehouse gets an index from us: uq_warehouse_entity has
-- warehouse_id leftmost, so it satisfies that FK. MySQL auto-creates one for
-- fk_dwe_entity, so an index by that name appearing that nobody declared is
-- expected.
CREATE TABLE IF NOT EXISTS details_warehouse_entity (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_id    INT NOT NULL COMMENT 'master_warehouse.id',
  entity_id       INT NOT NULL COMMENT 'master_entity.id',
  facility_code   VARCHAR(50)  NULL COMMENT 'Unicommerce facility — sent as the Facility header, see authHeaders() in lib/uniware.ts',
  gstin           VARCHAR(15)  NULL COMMENT 'The registration this entity bills this site under. Exactly 15 chars',
  bill_to_name    VARCHAR(200) NULL,
  bill_to_address TEXT         NULL,
  ship_to_name    VARCHAR(200) NULL,
  ship_to_address TEXT         NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active'
                    COMMENT 'A location can be live for one entity and not the other',
  created_at      DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME(0) NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_warehouse_entity (warehouse_id, entity_id),
  CONSTRAINT fk_dwe_warehouse FOREIGN KEY (warehouse_id) REFERENCES master_warehouse (id),
  CONSTRAINT fk_dwe_entity    FOREIGN KEY (entity_id)    REFERENCES master_entity (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- Matches master_warehouse and (after 2b) master_entity. Both FKs are on INT
-- columns so collation is not involved in them, and none of this table's string
-- columns is ever joined to another table's — but one collation across the whole
-- cluster removes the problem class instead of reasoning about it per query.
