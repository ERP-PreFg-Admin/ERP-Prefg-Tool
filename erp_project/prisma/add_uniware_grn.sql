-- WHAT: grn_uniware + grn_items_uniware — a read-only mirror of Unicommerce's
-- inflow receipts (GRNs) for the POs we mirror there. Plus one column,
-- invoice_mfg.uniware_grn_count, that makes the sweep cheap.
--
-- WHY: the inward chain stops one step short. invoice_mfg.uniware_po_code
-- mirrors our invoice into Uniware and uniware_status reports the PO's state,
-- but nothing reads the receipts — so REJECTED QUANTITY is invisible everywhere
-- in the ERP, and purchase_orders.received_qty still records what the INVOICE
-- claimed (written by lib/po/po-receive.ts at commit time), not what the
-- warehouse accepted.
--
-- ── THE RULE THIS SCHEMA EXISTS TO PROTECT ───────────────────────────────────
-- These tables are a MIRROR. Nothing in the sync path writes to
-- purchase_orders. received_qty is our record of what we were told arrived; the
-- GRN is the warehouse's record of what it accepted. They will disagree, and the
-- disagreement is the entire point — a sync that "reconciles" them by writing
-- GRN quantities into received_qty destroys the signal on its first run.
-- Reconciliation is derived at read time, three-way:
--     Ordered (purchase_orders.qty)
--       -> Invoiced (invoice_items_mfg.qty)
--         -> Accepted + Rejected (here)
--
-- ── ON grn_items_uniware.po_id ───────────────────────────────────────────────
-- Resolved at SYNC time, not read time. It works because mergeInwardLinesBySku
-- (lib/invoice/invoice-merge.ts) creates ONE inward PO per SKU, so our POs and
-- Uniware's receipt items line up 1:1 on (uniware_po_code, sku_code). That merge
-- rule is load-bearing for this table — if it ever changes, this join breaks.
--
-- NULL is a real state, not a failure: it means the warehouse received a SKU we
-- never raised a PO for. Stored and surfaced rather than dropped by a join.
--
-- ── ON `raw` ─────────────────────────────────────────────────────────────────
-- getInflowReceipt had never run live when this was written (see the FINDINGS
-- block in check_uniware_apis/po_grn.py), and on this API a wrong key reads as
-- an empty-but-successful record rather than erroring. Keeping the payload means
-- the first unmapped field costs a re-sync instead of a lost month. Drop the
-- column once the shape has been boring for a few months.
--
-- ── ON expiry / mfg_date being VARCHAR ───────────────────────────────────────
-- Same reason invoice_items_mfg.expiry and .mfg_date are: they are what the
-- document said, not something we derive. Uniware also mixes date formats inside
-- one payload (epoch millis beside plain 'YYYY-MM-DD'), so a DATE column here
-- would force a lossy guess at ingest.
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, and CREATE TABLE
-- uses IF NOT EXISTS but the ALTER does not.
--
-- Run on BOTH schemas (test and prod). Keep prisma/schema.prisma in sync.
-- Requires prisma/add_supplier_invoices.sql (invoice_mfg) to have run first.


-- ── 1. Pre-flight ────────────────────────────────────────────────────────────
-- Expect zero rows. Anything here means this file has already run — stop.
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('grn_uniware', 'grn_items_uniware');

SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'invoice_mfg' AND COLUMN_NAME = 'uniware_grn_count';


-- ── 2. The receipt header ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grn_uniware (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  grn_code           VARCHAR(64)  NOT NULL
                       COMMENT 'inflowReceiptCode — Uniware''s own identifier for the receipt',
  uniware_po_code    VARCHAR(64)  NOT NULL
                       COMMENT 'The mirrored PO this receipt is against. Joins invoice_mfg.uniware_po_code',
  invoice_id         INT NULL
                       COMMENT 'Resolved from uniware_po_code. NULL = a receipt against a PO we did not mirror',
  facility_code      VARCHAR(50)  NULL
                       COMMENT 'Which facility answered — the destination site under the entity billed, matched on PAN',
  status_code        VARCHAR(40)  NULL,
  vendor_invoice_no  VARCHAR(100) NULL
                       COMMENT 'The manufacturer''s invoice number as the warehouse keyed it — the join back to invoice_mfg.invoice_no',
  grn_created_at     DATETIME     NULL
                       COMMENT 'When Uniware created the receipt. Its `created` is epoch MILLISECONDS; divide by 1000 at ingest',
  total_qty          DECIMAL(12,3) NOT NULL DEFAULT 0
                       COMMENT 'Sum of the items, stored so a list does not need the item join',
  total_rejected_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
  synced_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw                JSON         NULL
                       COMMENT 'The receipt payload verbatim. Temporary — see the header comment',
  UNIQUE KEY uq_grn_code (grn_code),
  KEY idx_grn_po_code (uniware_po_code),
  KEY idx_grn_invoice (invoice_id),
  CONSTRAINT fk_grn_invoice FOREIGN KEY (invoice_id) REFERENCES invoice_mfg (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ── 3. The receipt lines ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grn_items_uniware (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  grn_id       INT NOT NULL,
  line_no      INT NOT NULL,
  sku_code     VARCHAR(50)  NULL,
  po_id        INT NULL
                 COMMENT 'OUR inward PO for this (uniware_po_code, sku_code). NULL = received a SKU we never raised',
  quantity     DECIMAL(12,3) NOT NULL DEFAULT 0
                 COMMENT 'Accepted quantity as Uniware reports it',
  rejected_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
  batch_code   VARCHAR(100) NULL,
  expiry       VARCHAR(20)  NULL,
  mfg_date     VARCHAR(20)  NULL,
  UNIQUE KEY uq_grn_line (grn_id, line_no),
  KEY idx_grn_item_sku (sku_code),
  KEY idx_grn_item_po (po_id),
  CONSTRAINT fk_grn_item_grn FOREIGN KEY (grn_id) REFERENCES grn_uniware (id) ON DELETE CASCADE,
  CONSTRAINT fk_grn_item_po  FOREIGN KEY (po_id)  REFERENCES purchase_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ── 4. What makes the sweep targeted ─────────────────────────────────────────
-- getPurchaseOrderDetails ALREADY returns inflowReceiptsCount, and the status
-- sync already calls it — so storing the count costs zero extra API calls and
-- turns the GRN sweep from "walk every mirrored PO" into "walk the ones whose
-- count is > 0 and differs from what we hold". GRNs are 1+N calls per PO, so
-- that difference is what keeps the sweep inside maxDuration.
--
-- NULL means never asked, matching uniware_synced_at's convention on this table.
ALTER TABLE invoice_mfg
  ADD COLUMN uniware_grn_count INT NULL
    COMMENT 'inflowReceiptsCount as of the last status sync. NULL = never asked, 0 = nothing received yet'
    AFTER uniware_synced_at;


-- ── Verify ───────────────────────────────────────────────────────────────────

-- Both tables present, with their keys.
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('grn_uniware', 'grn_items_uniware');

-- The column landed, nullable.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND COLUMN_NAME = 'uniware_grn_count';

-- Both uniqueness rules exist: one row per receipt, one row per receipt line.
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND INDEX_NAME IN ('uq_grn_code', 'uq_grn_line')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- After the first sweep, these are the numbers to read:
--
--   Receipts whose PO we do not recognise (should be 0 on a healthy tenant):
-- SELECT grn_code, uniware_po_code FROM grn_uniware WHERE invoice_id IS NULL;
--
--   Lines for a SKU we never raised a PO for — a real finding, not an error:
-- SELECT g.grn_code, i.sku_code, i.quantity, i.rejected_qty
--   FROM grn_items_uniware i JOIN grn_uniware g ON g.id = i.grn_id
--  WHERE i.po_id IS NULL;
--
--   The header totals must equal the sum of their lines:
-- SELECT g.grn_code, g.total_qty, SUM(i.quantity) AS line_qty,
--        g.total_rejected_qty, SUM(i.rejected_qty) AS line_rejected
--   FROM grn_uniware g JOIN grn_items_uniware i ON i.grn_id = g.id
--  GROUP BY g.id HAVING line_qty <> g.total_qty OR line_rejected <> g.total_rejected_qty;
