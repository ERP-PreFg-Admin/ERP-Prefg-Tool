-- WHAT: bank details on master_entity, for the PO document's "Company Bank
-- Details" band — which has shipped as an empty yellow heading for months.
--
-- WHY HERE: a bank account belongs to a legal entity, not to a warehouse. It is
-- the one piece of letterhead data that is NOT already in the schema.
--
-- NO ADDRESS OR GSTIN COLUMNS. details_warehouse_entity already carries
-- bill_to_name / bill_to_address / bill_to_gstin per (site, legal entity), and
-- that is the correct grain: GST registration is state-wise, so what we bill under
-- depends on the destination. A master_entity.address would be a second, coarser
-- copy of data that already exists — and the coarser copy is the one that would be
-- wrong for any delivery outside the entity's home state.
--
-- master_entity.legal_name (already NOT NULL) is all the letterhead needs from
-- this table besides the bank; see resolveLetterhead in lib/pdf/po-letterhead.ts.
--
-- All four columns are NULL. The band stays exactly as it is today until they are
-- filled in — resolveBank returns null unless name, account number and IFSC are
-- ALL present, deliberately: a half-filled bank block on a purchase order makes
-- the manufacturer guess, and the PDF gives no hint a field was never entered.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_warehouse_master.sql (master_entity) to have run first.

-- ⚠️ IF YOU ALREADY RAN THE SUPERSEDED add_entity_letterhead.sql (dev did, on
-- 2026-08-14) the four bank columns are ALREADY THERE, plus two that are now dead:
-- `address` and `default_gstin`. Skip the ALTER below and run the reconcile block
-- at the end of this file instead. Check first:
--
--   SELECT COLUMN_NAME FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_entity';

ALTER TABLE master_entity
  ADD COLUMN bank_name       VARCHAR(150) NULL AFTER pan,
  ADD COLUMN bank_account_no VARCHAR(30)  NULL
    COMMENT 'VARCHAR, not an integer — leading zeros are significant'
    AFTER bank_name,
  ADD COLUMN bank_ifsc       VARCHAR(11)  NULL AFTER bank_account_no,
  ADD COLUMN bank_branch     VARCHAR(150) NULL AFTER bank_ifsc;


-- ── Fill in by hand ──────────────────────────────────────────────────────────
-- No admin UI for master_entity — two rows that change approximately never. Leave
-- a value NULL rather than guessing it; a partial block is suppressed entirely.
--
-- UPDATE master_entity SET
--   bank_name = NULL, bank_account_no = NULL, bank_ifsc = NULL, bank_branch = NULL
--  WHERE code = 'PEP';
--
-- UPDATE master_entity SET
--   bank_name = NULL, bank_account_no = NULL, bank_ifsc = NULL, bank_branch = NULL
--  WHERE code = 'KREATIVE';


-- ── Reconcile a schema that ran add_entity_letterhead.sql ────────────────────
-- Only for a schema that already has `address` and `default_gstin`. Nothing reads
-- them: the bill-to comes from details_warehouse_entity, and master_entity
-- contributes only legal_name and the bank. Leaving them is harmless but
-- misleading — they look like the letterhead's source and are not.
--
-- Both are NULL on every row unless someone filled them in, so check before
-- dropping. This one query decides it; if it returns any row, copy those values
-- into the right (site, entity) row on details_warehouse_entity FIRST.
--
--   SELECT id, code, address, default_gstin FROM master_entity
--    WHERE address IS NOT NULL OR default_gstin IS NOT NULL;
--
-- Then, once it returns nothing:
--
-- ALTER TABLE master_entity DROP COLUMN address, DROP COLUMN default_gstin;


-- ── Verify ───────────────────────────────────────────────────────────────────

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_entity'
 ORDER BY ORDINAL_POSITION;

-- `bank_ready` is what the template switches on. 0 means the band stays the empty
-- heading it is today.
SELECT code, legal_name,
       (bank_name IS NOT NULL AND bank_account_no IS NOT NULL AND bank_ifsc IS NOT NULL) AS bank_ready
  FROM master_entity ORDER BY code;

-- Where the letterhead actually comes from. A pair with no bill_to_gstin prints a
-- correct legal name and NO address — visibly incomplete, rather than confidently
-- showing the wrong entity's registration. Fill these through /masters/warehouses.
SELECT w.name AS warehouse, e.code AS entity,
       dwe.bill_to_name IS NOT NULL AS has_name,
       dwe.bill_to_address IS NOT NULL AS has_address,
       dwe.bill_to_gstin
  FROM details_warehouse_entity dwe
  JOIN master_warehouse w ON w.id = dwe.warehouse_id
  JOIN master_entity    e ON e.id = dwe.entity_id
 WHERE dwe.status = 'active'
 ORDER BY w.name, e.code;
