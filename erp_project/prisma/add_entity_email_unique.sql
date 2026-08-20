-- entity_emails: one address per entity, and an "all warehouses" wildcard.
--
-- WHAT
--   A UNIQUE index over (entity_type, entity_code, legal_entity_key, email), where
--   legal_entity_key is a generated column holding COALESCE(legal_entity_code,'').
--
-- WHY THE GENERATED COLUMN
--   legal_entity_code is nullable, and MySQL treats NULLs as DISTINCT in a unique
--   index. Indexing the raw column would therefore allow the same address twice
--   for the same warehouse as long as both rows had a NULL entity — which is the
--   commonest case, and exactly the duplicate we are trying to prevent. Folding
--   NULL to '' first makes "every entity" a single comparable value.
--
--   STORED rather than VIRTUAL: MySQL can index either, but a stored column is
--   readable in EXPLAIN output and in a plain SELECT, which matters when someone
--   is working out why an insert was rejected.
--
-- WHY UNIQUENESS INCLUDES THE LEGAL ENTITY
--   A site is one master_warehouse row but two destinations — Pep's Mumbai and
--   Kreative's are different places to send goods, and can legitimately have
--   different contacts. The same shared inbox may therefore appear once per
--   entity. What must not happen is the same address twice for the SAME entity,
--   which duplicates that recipient on every mail.
--
-- ALSO: THE '*' WILDCARD NOW APPLIES TO WAREHOUSES
--   entity_code = '*' already meant "every manufacturer" on an employee row.
--   A warehouse row may now carry it too, meaning "every warehouse" — including
--   sites added later, without anyone revisiting this list. No schema change is
--   needed for that (entity_code is a VARCHAR with no FK, which is why the API
--   validates it instead); the matching arm is in
--   lib/queries/entity-emails.ts selectByWarehouseForEntity.
--
-- BEFORE RUNNING
--   The ALTER fails if duplicates already exist. Check with:
--
--     SELECT entity_type, entity_code, COALESCE(legal_entity_code,'') AS le,
--            email, COUNT(*) AS c
--       FROM entity_emails
--      GROUP BY entity_type, entity_code, COALESCE(legal_entity_code,''), email
--     HAVING COUNT(*) > 1;
--
--   Verified empty on dev at 2026-08-20 (2 rows total). Re-check on prod.
--
-- MySQL 8.0: no ADD COLUMN IF NOT EXISTS, so this is NOT re-runnable. Run once
-- per schema.

ALTER TABLE entity_emails
  ADD COLUMN legal_entity_key VARCHAR(50)
    AS (COALESCE(legal_entity_code, '')) STORED;

ALTER TABLE entity_emails
  ADD UNIQUE KEY uq_entity_email (entity_type, entity_code, legal_entity_key, email);
