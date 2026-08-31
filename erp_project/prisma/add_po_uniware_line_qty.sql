-- WHAT: two quantities Unicommerce reports per PO line, mirrored onto our own
-- inward PO rows — `un_pending_qty` and `un_qc_pass_qty` — plus the timestamp
-- that says when we last asked.
--
-- WHY THESE TWO AND NOT ALL FOUR: getPurchaseOrderDetails returns
-- quantity / pendingQuantity / receivedQuantity / qcPassQuantity /
-- rejectedQuantity per line. Received and rejected we already hold, derived from
-- the goods receipts in grn_items_uniware, and showing the same quantity twice
-- under two names is how a reader stops trusting either. Pending and QC-pass
-- have NO local equivalent — nothing in this schema knows how much of a line
-- Uniware still considers outstanding, or how much cleared QC.
--
-- ── ON THE `un_` PREFIX ──────────────────────────────────────────────────────
-- These are UNICOMMERCE's numbers sitting on OUR order table, one column away
-- from `received_qty`, which is ours and means something different: received_qty
-- is what the invoice claimed at inward time, un_* is what the warehouse's system
-- says. They will disagree, and the disagreement is the point. The prefix is what
-- stops the next person averaging them or "fixing" one from the other.
--
-- Nothing in the app writes these except the Uniware sync, and nothing derives
-- received_qty from them. See lib/uniware/grn-sync.ts's header for the same rule
-- stated about goods receipts.
--
-- ── WHY NOT A MIRROR TABLE ───────────────────────────────────────────────────
-- grn_uniware / grn_items_uniware are a separate mirror because a receipt has no
-- row of ours to hang off — it is its own document with its own lines. A PO line
-- does: mergeInwardLinesBySku raises exactly ONE inward PO per SKU, so a Uniware
-- PO line and a purchase_orders row are 1:1 and a table would be a join for
-- nothing. `uniware_po_code` already lives on this table for the same reason.
--
-- ── ON NULL ──────────────────────────────────────────────────────────────────
-- NULL means never asked, 0 means Uniware said zero. `un_line_synced_at` is what
-- separates them — same convention as invoice_mfg.uniware_synced_at, and the
-- reason a plain 0 default would have been wrong.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.


-- ── 1. Pre-flight ────────────────────────────────────────────────────────────
-- Expect zero rows. Anything here means this file has already run — stop.
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders'
   AND COLUMN_NAME IN ('un_pending_qty', 'un_qc_pass_qty', 'un_line_synced_at');


-- ── 2. The columns ───────────────────────────────────────────────────────────
ALTER TABLE purchase_orders
  ADD COLUMN un_pending_qty DECIMAL(12,3) NULL
    COMMENT 'Unicommerce pendingQuantity for this PO line. THEIRS, not ours — never derive received_qty from it. NULL = never asked'
    AFTER received_qty,
  ADD COLUMN un_qc_pass_qty DECIMAL(12,3) NULL
    COMMENT 'Unicommerce qcPassQuantity for this PO line. NULL = never asked'
    AFTER un_pending_qty,
  ADD COLUMN un_line_synced_at DATETIME NULL
    COMMENT 'When the two above were last read. NULL = never asked, which is not the same as Uniware reporting zero'
    AFTER un_qc_pass_qty;


-- ── Verify ───────────────────────────────────────────────────────────────────

-- All three present, all nullable, no default.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders'
   AND COLUMN_NAME IN ('un_pending_qty', 'un_qc_pass_qty', 'un_line_synced_at');

-- After the first sync, these are the numbers to read:
--
--   Inward POs Uniware has answered about at all:
-- SELECT COUNT(*) FROM purchase_orders
--  WHERE po_type = 'inward' AND un_line_synced_at IS NOT NULL;
--
--   Where OUR received_qty and Uniware's outstanding disagree. Not an error —
--   this is the reconciliation the columns exist to make visible.
-- SELECT po_no, sku_code, qty, received_qty, un_pending_qty, un_qc_pass_qty
--   FROM purchase_orders
--  WHERE un_line_synced_at IS NOT NULL
--    AND un_pending_qty <> (qty - COALESCE(received_qty, 0));
