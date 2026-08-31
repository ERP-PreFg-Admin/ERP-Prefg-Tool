-- PROD CATCH-UP — 2026-08-31
--
-- Everything mcaff_prefg_prod is missing that the current code requires. Written
-- against a live read of the prod schema on 2026-08-31, not against dev:
--
--   purchase_orders    21 columns, `remarks` ALREADY PRESENT at position 15,
--                      `received_qty` at 11 (the AFTER anchor below), 0 rows
--   invoice_mfg        `uniware_synced_at` at position 21 (the AFTER anchor),
--                      0 rows
--   both `id` columns  INT NOT NULL — the FKs below match
--   every table        InnoDB / utf8mb4_0900_ai_ci — the CREATEs below match, so
--                      the joins are not mixed-collation comparisons
--   page_permissions   access_level ENUM('none','viewer','editor'), 36 rows,
--                      no '/uniware' row yet
--
-- BOTH ALTERED TABLES ARE EMPTY, so these are instant and carry no rewrite risk.
--
-- ── WHY THIS IS URGENT, NOT OPTIONAL ─────────────────────────────────────────
-- Sections 1 and 2 are BLOCKING. The deployed code already references the
-- objects they create:
--   * INVOICE_LIST_BODY selects from grn_uniware / grn_items_uniware, so
--     /po-tracking/invoices returns 500 without section 1.
--   * selectItemsByInvoiceId selects purchase_orders.un_*, so expanding any
--     invoice returns 500 without section 2.
-- Section 3 is a convenience and can wait — see its own note.
--
-- ALREADY APPLIED HERE, deliberately absent below:
--   prisma/add_po_remarks.sql            purchase_orders.remarks
--   prisma/add_warehouse_po_short_code.sql
--
-- RE-RUNNABLE: no. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS, and the CREATEs
-- use IF NOT EXISTS but the ALTERs do not. Run the pre-flight first.
--
-- Sources, kept as the canonical per-feature files:
--   prisma/add_uniware_grn.sql            (section 1)
--   prisma/add_po_uniware_line_qty.sql    (section 2)
--   prisma/add_uniware_explorer_page.sql  (section 3)


-- ═══ 0. PRE-FLIGHT — read this before running anything ═══════════════════════
-- Expect: no rows from the first two, and 0 from the third. Anything else means
-- part of this has already run; stop and apply only what is missing.

SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('grn_uniware', 'grn_items_uniware');

SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'invoice_mfg'     AND COLUMN_NAME = 'uniware_grn_count')
     OR (TABLE_NAME = 'purchase_orders' AND COLUMN_NAME IN
         ('un_pending_qty', 'un_qc_pass_qty', 'un_line_synced_at')));

SELECT COUNT(*) AS uniware_grant_rows FROM page_permissions WHERE page_slug = '/uniware';

-- The two anchors the ALTERs below position against must exist.
SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'received_qty')
     OR (TABLE_NAME = 'invoice_mfg'     AND COLUMN_NAME = 'uniware_synced_at'));


-- ═══ 1. GOODS RECEIPTS — the Unicommerce GRN mirror ══════════════════════════
-- BLOCKING. /po-tracking/invoices 500s until this exists.
--
-- These tables are a MIRROR. Nothing in the sync path writes to purchase_orders:
-- received_qty is what the INVOICE claimed at inward time, a GRN is what the
-- WAREHOUSE accepted, and the two disagreeing is the entire point of the
-- feature. Reconciliation is derived at read time, three-way:
--     Ordered (purchase_orders.qty)
--       -> Invoiced (invoice_items_mfg.qty)
--         -> Accepted + Rejected (here)
--
-- grn_items_uniware.po_id resolves 1:1 only because mergeInwardLinesBySku
-- (lib/invoice/invoice-merge.ts) raises ONE inward PO per SKU. NULL is a real
-- state: the warehouse received a SKU we never raised.
--
-- `raw` keeps the payload verbatim while getInflowReceipt's shape is still
-- unconfirmed live — the first unmapped field then costs a re-sync, not a lost
-- month. Drop the column once the shape has been boring for a few months.

CREATE TABLE IF NOT EXISTS grn_uniware (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  grn_code           VARCHAR(64)  NOT NULL
                       COMMENT 'inflowReceiptCode — Uniware''s own identifier for the receipt',
  uniware_po_code    VARCHAR(64)  NOT NULL
                       COMMENT 'The mirrored PO this receipt is against. Joins invoice_mfg.uniware_po_code',
  invoice_id         INT NULL
                       COMMENT 'Resolved from uniware_po_code. NULL = a receipt against a PO we did not mirror',
  facility_code      VARCHAR(50)  NULL,
  status_code        VARCHAR(40)  NULL,
  vendor_invoice_no  VARCHAR(100) NULL
                       COMMENT 'The manufacturer''s invoice number as the warehouse keyed it',
  grn_created_at     DATETIME     NULL
                       COMMENT 'Uniware''s `created` is epoch MILLISECONDS; divided by 1000 at ingest',
  total_qty          DECIMAL(12,3) NOT NULL DEFAULT 0,
  total_rejected_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
  synced_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw                JSON         NULL
                       COMMENT 'The receipt payload verbatim. Temporary — see the header',
  UNIQUE KEY uq_grn_code (grn_code),
  KEY idx_grn_po_code (uniware_po_code),
  KEY idx_grn_invoice (invoice_id),
  CONSTRAINT fk_grn_invoice FOREIGN KEY (invoice_id) REFERENCES invoice_mfg (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS grn_items_uniware (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  grn_id       INT NOT NULL,
  line_no      INT NOT NULL,
  sku_code     VARCHAR(50)  NULL,
  po_id        INT NULL
                 COMMENT 'OUR inward PO for this (uniware_po_code, sku_code). NULL = a SKU we never raised',
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

-- getPurchaseOrderDetails ALREADY returns inflowReceiptsCount beside statusCode,
-- and the status sync already makes that call — so storing it costs no extra
-- request and turns the GRN sweep from "walk every mirrored PO" into "walk the
-- ones that have receipts". GRNs are 1+N calls per PO; that filter is what keeps
-- the sweep inside maxDuration.
--
-- NULL = never asked, which is NOT the same as 0 = nothing received yet.
ALTER TABLE invoice_mfg
  ADD COLUMN uniware_grn_count INT NULL
    COMMENT 'inflowReceiptsCount as of the last status sync. NULL = never asked, 0 = nothing received yet'
    AFTER uniware_synced_at;


-- ═══ 2. UNICOMMERCE PO-LINE QUANTITIES ═══════════════════════════════════════
-- BLOCKING. Expanding an invoice 500s until these exist.
--
-- Only pending and QC-pass, not all four Uniware reports: received and rejected
-- already come from grn_items_uniware above, and the same quantity under two
-- names is how a reader stops trusting either. These two have no local
-- equivalent — nothing else here knows how much of a line Uniware still
-- considers outstanding, or how much cleared QC.
--
-- ON THE `un_` PREFIX: these sit one column away from received_qty, which is
-- OURS and means something different. The prefix is what stops the next person
-- averaging them or "fixing" one from the other. Only the Uniware sync writes
-- them, and nothing derives received_qty from them.
--
-- No mirror table, unlike section 1: a receipt has no row of ours to hang off,
-- but a PO line does — mergeInwardLinesBySku makes it 1:1 with purchase_orders,
-- so a table would be a join for nothing. uniware_po_code already lives here.

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


-- ═══ 3. THE UNIWARE EXPLORER PAGE GRANT ══════════════════════════════════════
-- NOT blocking, and a real access decision — apply it only when you have decided
-- who should hold it.
--
-- Without this row /uniware is invisible in the sidebar and the page redirects,
-- which is a safe default. The slug is TOP-LEVEL precisely so that absence means
-- denial: resolveAccess walks a slug up its parents and stops at the first one
-- the user's own roles hold a row for, so '/admin/uniware' with a developer-only
-- row would still admit every admin through their '/admin' grant.
--
-- DEVELOPER ONLY. The page has no entity scoping and cannot have any — it reads
-- the Uniware tenant by facility code, so the grant means "may read every
-- purchase order at every facility, across both legal entities and every brand".
-- It also bypasses the sandbox facility pin, so a developer on a dev box is
-- talking to real warehouses.
--
-- Adding a row for 'admin' here would undo the whole point of the slug choice.
--
-- Re-runnable: ON DUPLICATE KEY UPDATE (uq role_page_slug).

-- INSERT INTO page_permissions (role, page_slug, access_level)
-- VALUES ('developer', '/uniware', 'editor')
-- ON DUPLICATE KEY UPDATE access_level = VALUES(access_level);


-- ═══ VERIFY ══════════════════════════════════════════════════════════════════

-- Both tables present, InnoDB, and on the same collation as everything they join.
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('grn_uniware', 'grn_items_uniware');

-- All four new columns, all nullable, no default.
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'invoice_mfg'     AND COLUMN_NAME = 'uniware_grn_count')
     OR (TABLE_NAME = 'purchase_orders' AND COLUMN_NAME IN
         ('un_pending_qty', 'un_qc_pass_qty', 'un_line_synced_at')))
 ORDER BY TABLE_NAME, COLUMN_NAME;

-- Both uniqueness rules exist (NON_UNIQUE must be 0): one row per receipt, and
-- one row per receipt line. The first is what makes the upsert idempotent.
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('uq_grn_code', 'uq_grn_line')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- All three foreign keys resolved to the right parents.
SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
  FROM information_schema.KEY_COLUMN_USAGE
 WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
   AND TABLE_NAME IN ('grn_uniware', 'grn_items_uniware');

-- Smoke test: the exact aggregate shape /po-tracking/invoices runs. Zero rows is
-- the correct answer on an empty schema; an ERROR means section 1 did not apply.
SELECT si.id,
       (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
       (SELECT COALESCE(SUM(i.rejected_qty), 0)
          FROM grn_items_uniware i JOIN grn_uniware g ON g.id = i.grn_id
         WHERE g.invoice_id = si.id) AS grn_rejected
  FROM invoice_mfg si
 LIMIT 1;

-- Smoke test: the columns the invoice expansion selects. Zero rows is fine.
SELECT id, po_no, received_qty, un_pending_qty, un_qc_pass_qty, un_line_synced_at
  FROM purchase_orders LIMIT 1;
