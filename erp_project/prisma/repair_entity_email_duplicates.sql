-- WHAT: removes duplicate entity_emails rows so add_entity_email_unique.sql's
-- UNIQUE KEY can be created. Data repair, not a schema change. Run this FIRST,
-- then add_entity_email_unique.sql.
--
-- WHY: add_entity_email_unique.sql adds
--   UNIQUE KEY uq_entity_email (entity_type, entity_code, legal_entity_key, email)
-- and its own header says "Verified empty on dev at 2026-08-20. Re-check on
-- prod." Re-checked on prod 2026-08-22 — it is NOT empty, so that ALTER will
-- fail with ER_DUP_ENTRY until this runs.
--
-- A duplicate is not harmless: entity_emails is the mail recipient list
-- (lib/mail/recipients.ts), so a doubled row addresses the same person twice on
-- every PO and inward notification. splitRecipients() dedupes To-over-CC when it
-- builds a message, which is exactly why nobody noticed.
--
-- FOUND ON mcaff_prefg_prod, 2026-08-22 (66 rows total, 1 duplicate group):
--   entity_type=mfg  entity_code=MFG-005-NGE  legal_entity_code=NULL
--   email=ppic3@ngelectro.com  ids 20,21  recipient_type both 'to'
--   purpose both 'POC'
-- The two rows are identical in every meaningful column, so dropping the higher
-- id is lossless. Dev was clean.
--
-- WHAT IS KEPT: the LOWEST id per uniqueness group — the original row. Later
-- copies go. Nothing outside entity_emails references entity_emails.id (no FK
-- points at it; recipients are resolved by entity_type + entity_code), so
-- deleting the higher id cannot orphan anything.
--
-- ⚠️ THIS DELETES ROWS. Run STEP 1 and read it before running STEP 2. If any
-- group's `differing_columns` is not 'none', the copies are NOT identical and
-- deleting one loses information — reconcile those by hand instead.
--
-- RE-RUNNABLE: yes. Once each group has one row it stops matching.
--
-- DRY-RUN VERIFIED against mcaff_prefg_prod (2026-08-22), executed inside a
-- transaction and rolled back. Result:
--   before      66 rows, 1 duplicate group (ids 20,21)
--   will_delete id 21 only  (mfg / MFG-005-NGE / ppic3@ngelectro.com / to / POC)
--   deleted     affectedRows: 1
--   after       65 rows, 0 duplicate groups
--   kept        id 20, same recipient_type and purpose — nothing lost
-- Not applied. Nothing was committed.

-- ── STEP 1: report every group, and whether the copies actually agree ────────
SELECT
  entity_type,
  entity_code,
  COALESCE(legal_entity_code, '') AS legal_entity_key,
  email,
  COUNT(*)                        AS copies,
  GROUP_CONCAT(id ORDER BY id)    AS ids,
  MIN(id)                         AS keeping_id,
  -- Which columns disagree across the copies. 'none' means the delete below is
  -- lossless; anything else is a signal to look before deleting.
  TRIM(BOTH ',' FROM CONCAT(
    IF(COUNT(DISTINCT recipient_type)        > 1, 'recipient_type,', ''),
    IF(COUNT(DISTINCT COALESCE(purpose, '')) > 1, 'purpose,',        '')
  ))                              AS differing_columns_raw,
  IF(COUNT(DISTINCT recipient_type) > 1 OR COUNT(DISTINCT COALESCE(purpose, '')) > 1,
     'REVIEW', 'none')            AS differing_columns
FROM entity_emails
GROUP BY entity_type, entity_code, COALESCE(legal_entity_code, ''), email
HAVING COUNT(*) > 1
ORDER BY entity_type, entity_code, email;

-- ── STEP 2: delete the later copies ─────────────────────────────────────────
-- Joins a DERIVED table rather than a correlated subquery: MySQL raises
-- ER_UPDATE_TABLE_USED for `DELETE FROM t WHERE id NOT IN (SELECT ... FROM t)`,
-- but materialises a derived table in a join, so this form is allowed. A temp
-- table is not an option either — the app's DB user has no CREATE TEMPORARY
-- TABLES privilege.
--
-- Wrapped in a transaction: DML, so ROLLBACK genuinely undoes it.

START TRANSACTION;

-- The exact rows about to be deleted. Review, then COMMIT.
SELECT e.id, e.entity_type, e.entity_code, e.email, e.recipient_type, e.purpose
FROM entity_emails e
JOIN (
  SELECT entity_type, entity_code, COALESCE(legal_entity_code, '') AS lek, email,
         MIN(id) AS keep_id
  FROM entity_emails
  GROUP BY entity_type, entity_code, COALESCE(legal_entity_code, ''), email
  HAVING COUNT(*) > 1
) d
  ON  d.entity_type = e.entity_type
  AND d.entity_code = e.entity_code
  AND d.lek         = COALESCE(e.legal_entity_code, '')
  AND d.email       = e.email
WHERE e.id <> d.keep_id
ORDER BY e.id;

DELETE e
FROM entity_emails e
JOIN (
  SELECT entity_type, entity_code, COALESCE(legal_entity_code, '') AS lek, email,
         MIN(id) AS keep_id
  FROM entity_emails
  GROUP BY entity_type, entity_code, COALESCE(legal_entity_code, ''), email
  HAVING COUNT(*) > 1
) d
  ON  d.entity_type = e.entity_type
  AND d.entity_code = e.entity_code
  AND d.lek         = COALESCE(e.legal_entity_code, '')
  AND d.email       = e.email
WHERE e.id <> d.keep_id;

COMMIT;

-- Verify: STEP 1 should now return zero rows. Then run
-- prisma/add_entity_email_unique.sql, which will succeed.
