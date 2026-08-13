-- WHAT: let a warehouse's mail recipients differ per legal entity. Adds
-- legal_entity_code to entity_emails.
--
-- WHY: every warehouse operates under both Pep and Kreative, and the point of
-- contact at the site is not necessarily the same person for both. Until now
-- entity_emails keyed a warehouse by name alone, so one recipient list served
-- both entities' goods.
--
-- SEMANTICS: NULL means "applies to every legal entity". Recipients are the
-- UNION of the NULL rows and the rows matching the entity being mailed — so a
-- general warehouse inbox keeps receiving everything and an entity's POC is added
-- on top. Deliberately not an override: under-notifying is silent (lib/mailer.ts
-- logs "no email on file, skipping" and returns false), so the failure mode of
-- the union is a redundant mail rather than a missed one.
--
-- Backwards compatible by construction: every existing row gets NULL and
-- therefore keeps behaving exactly as it did.
--
-- WAREHOUSE ONLY. Vendors and manufacturers are counterparties — they deal with
-- us as one company, so a per-entity contact has no meaning there. The route
-- rejects a value on those types; no CHECK constraint, because the rule is about
-- which UI writes the row rather than something worth failing an INSERT over.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_master.sql (master_entity) to have run first.

ALTER TABLE entity_emails
  ADD COLUMN legal_entity_code VARCHAR(50) NULL
    COMMENT 'master_entity.code. NULL = applies to every entity. Warehouse rows only'
    AFTER entity_code;

-- The lookup index has to cover the new column or every inward mail does a range
-- scan on (entity_type, entity_code) and filters legal_entity_code in memory.
-- Dropped and recreated rather than added alongside: two overlapping indexes on
-- the same leading columns would both be maintained on write for no read gain.
ALTER TABLE entity_emails
  DROP INDEX idx_entity_emails_lookup,
  ADD INDEX idx_entity_emails_lookup (entity_type, entity_code, legal_entity_code);


-- ── Verify ───────────────────────────────────────────────────────────────────

-- The new column, and the widened index.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'entity_emails'
 ORDER BY ORDINAL_POSITION;

SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'entity_emails'
   AND INDEX_NAME = 'idx_entity_emails_lookup'
 ORDER BY SEQ_IN_INDEX;

-- Every pre-existing row must be NULL — that is what keeps current mail routing
-- unchanged.
SELECT entity_type, COUNT(*) rows_total, SUM(legal_entity_code IS NULL) shared
  FROM entity_emails GROUP BY entity_type;

-- Must return zero rows: a legal_entity_code that doesn't match master_entity, or
-- one set on a non-warehouse type.
SELECT ee.id, ee.entity_type, ee.entity_code, ee.legal_entity_code
  FROM entity_emails ee
  LEFT JOIN master_entity e ON e.code = ee.legal_entity_code
 WHERE ee.legal_entity_code IS NOT NULL
   AND (e.id IS NULL OR ee.entity_type <> 'warehouse');
