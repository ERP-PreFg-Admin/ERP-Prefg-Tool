-- What: soft revert of an inwarded invoice. invoice_mfg gains the revert audit columns
--       and a generated live_invoice_no; uq_supplier_invoice moves onto it, so a reverted
--       invoice steps aside and the same number can be inwarded again. purchase_orders.status
--       gains 'reverted' for the inward POs of a reverted invoice (appended: no ordinal moves).
-- Why:  reverts used to delete rows (2026-10-08 Reve invoices). See docs/invoice-revert-plan.md.
-- Re-runnable: NO (MySQL 8 has no ADD COLUMN IF NOT EXISTS). The pre-flight shows whether it ran.
-- Run on dev (mcaff_prefg_dev) first and stop. Prod on its own go-ahead, BEFORE any code that
-- reads these columns reaches main. Safe under today's code: nothing old writes them.

-- ── 1. Pre-flight ──────────────────────────────────────────────────────────
-- Expect zero rows. Any row means this file already ran: stop.
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'invoice_mfg' AND COLUMN_NAME IN
          ('reverted_at','reverted_by','revert_approved_by','revert_approval_id',
           'revert_reason','live_invoice_no'));

-- Expect the 8 values ending in 'rejected', default 'draft'. If it differs, adjust step 4 to match plus 'reverted'.
SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'status';

-- Expect exactly (mfg_id, invoice_no). invoice-inward.ts matches ER_DUP_ENTRY on this name.
SELECT SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND INDEX_NAME = 'uq_supplier_invoice' ORDER BY SEQ_IN_INDEX;

-- Expect another index leading with mfg_id, so the mfg FK survives the drop.
SELECT INDEX_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND COLUMN_NAME = 'mfg_id' AND SEQ_IN_INDEX = 1;

-- invoice_no's collation must equal the table default (the generated column takes the
-- default). If they differ, add COLLATE <that> to live_invoice_no below.
SELECT c.COLLATION_NAME AS column_collation, t.TABLE_COLLATION
  FROM information_schema.COLUMNS c
  JOIN information_schema.TABLES t
    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
 WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'invoice_mfg'
   AND c.COLUMN_NAME = 'invoice_no';

-- Informational: legacy lines with no inward PO (they reverse but stale nothing).
SELECT link_type, COUNT(*) FROM invoice_items_mfg WHERE po_id IS NULL GROUP BY link_type;

-- ── 2. Audit columns ───────────────────────────────────────────────────────
ALTER TABLE invoice_mfg
  ADD COLUMN reverted_at DATETIME NULL
    COMMENT 'Set when an INVOICE_REVERT approval is approved. NULL = live' AFTER created_at,
  ADD COLUMN reverted_by INT NULL COMMENT 'Requester (approvals.raised_by)' AFTER reverted_at,
  ADD COLUMN revert_approved_by INT NULL COMMENT 'Approver (approvals.approved_by)' AFTER reverted_by,
  ADD COLUMN revert_approval_id INT NULL AFTER revert_approved_by,
  ADD COLUMN revert_reason VARCHAR(500) NULL AFTER revert_approval_id,
  ADD CONSTRAINT fk_invoice_mfg_reverted_by   FOREIGN KEY (reverted_by)        REFERENCES users (id),
  ADD CONSTRAINT fk_invoice_mfg_revert_appr   FOREIGN KEY (revert_approved_by) REFERENCES users (id),
  ADD CONSTRAINT fk_invoice_mfg_revert_apprvl FOREIGN KEY (revert_approval_id) REFERENCES approvals (id);

-- ── 3. One LIVE invoice per (mfg, number); reverted ones step aside ─────────
-- A UNIQUE index allows any number of NULLs. Same key name on purpose.
ALTER TABLE invoice_mfg
  ADD COLUMN live_invoice_no VARCHAR(100)
    GENERATED ALWAYS AS (IF(reverted_at IS NULL, invoice_no, NULL)) STORED
    COMMENT 'invoice_no while live, NULL once reverted. Never written' AFTER invoice_no,
  DROP INDEX uq_supplier_invoice,
  ADD UNIQUE KEY uq_supplier_invoice (mfg_id, live_invoice_no);

-- ── 4. Reverted inward POs ──────────────────────────────────────────────────
-- Appended at the end, default unchanged. Every reader treats it as terminal, like 'cancelled'.
ALTER TABLE purchase_orders
  MODIFY COLUMN status ENUM('draft','raised','punched','short_closed','partially_received',
                            'received','cancelled','rejected','reverted') NOT NULL DEFAULT 'draft';

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 6 rows: the invoice_mfg columns.
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'invoice_mfg' AND COLUMN_NAME IN
          ('reverted_at','reverted_by','revert_approved_by','revert_approval_id',
           'revert_reason','live_invoice_no');

-- status now ends in 'reverted'.
SELECT COLUMN_TYPE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'status';

-- uq_supplier_invoice is now (mfg_id, live_invoice_no).
SELECT SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND INDEX_NAME = 'uq_supplier_invoice' ORDER BY SEQ_IN_INDEX;

-- Zero rows: every existing invoice is live and its generated value matches.
SELECT id FROM invoice_mfg
 WHERE reverted_at IS NOT NULL OR NOT (live_invoice_no <=> invoice_no);

-- ── Rollback (only before the first revert; afterwards the old key can collide) ──
-- ALTER TABLE invoice_mfg DROP INDEX uq_supplier_invoice,
--   ADD UNIQUE KEY uq_supplier_invoice (mfg_id, invoice_no), DROP COLUMN live_invoice_no;
-- ALTER TABLE invoice_mfg DROP FOREIGN KEY fk_invoice_mfg_reverted_by,
--   DROP FOREIGN KEY fk_invoice_mfg_revert_appr, DROP FOREIGN KEY fk_invoice_mfg_revert_apprvl,
--   DROP COLUMN reverted_at, DROP COLUMN reverted_by, DROP COLUMN revert_approved_by,
--   DROP COLUMN revert_approval_id, DROP COLUMN revert_reason;
-- ALTER TABLE purchase_orders MODIFY COLUMN status ENUM('draft','raised','punched','short_closed',
--   'partially_received','received','cancelled','rejected') NOT NULL DEFAULT 'draft';
