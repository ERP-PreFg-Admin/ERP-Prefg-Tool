-- Supplier invoice header + line items, for the PO Inwarding "Add Invoice" flow.
--
-- Why this exists:
--   1. The review dialog collects e-way bill, vehicle no, currency, both GSTINs,
--      bill-to/ship-to and the invoice total, and none of it was being stored —
--      only the line quantities survived, onto purchase_orders.
--   2. Re-submitting the same invoice silently re-credited received_qty on any
--      referenced PO. UNIQUE (mfg_id, invoice_no) makes that a DB error instead
--      of corrupt inventory. Keyed on both columns because two manufacturers can
--      each legitimately issue "INV-001".
--
-- One line item per row, each tagged to the purchase_orders row it relates to —
-- the model is one PO per SKU, so a line maps to exactly one PO.
--
-- Re-running is a harmless no-op. Run on BOTH schemas (test and prod).
-- Keep prisma/schema.prisma in sync.

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  mfg_id          INT           NOT NULL,
  invoice_no      VARCHAR(100)  NOT NULL,
  invoice_date    DATE          NULL,
  currency        VARCHAR(10)   NULL,
  eway_bill_no    VARCHAR(50)   NULL,
  vehicle_no      VARCHAR(50)   NULL,
  po_ref          VARCHAR(100)  NULL COMMENT 'Buyer PO number printed on the invoice, as text',
  seller_gstin    VARCHAR(20)   NULL,
  buyer_gstin     VARCHAR(20)   NULL,
  bill_to_name    VARCHAR(255)  NULL,
  bill_to_address TEXT          NULL,
  bill_to_state   VARCHAR(100)  NULL,
  ship_to_name    VARCHAR(255)  NULL,
  ship_to_address TEXT          NULL,
  destination     VARCHAR(100)  NULL COMMENT 'Receiving warehouse chosen at review time',
  invoice_total   DECIMAL(14,4) NULL COMMENT 'Grand total as printed, incl. tax',
  attachment_key  TEXT          NULL COMMENT 'S3 key of the original PDF',
  created_by      INT           NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supplier_invoice (mfg_id, invoice_no),
  KEY idx_supplier_invoices_mfg (mfg_id),
  CONSTRAINT fk_supplier_invoices_mfg
    FOREIGN KEY (mfg_id) REFERENCES master_mfgs (id),
  CONSTRAINT fk_supplier_invoices_user
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id      INT           NOT NULL,
  line_no         INT           NOT NULL COMMENT 'Position on the invoice, 1-based',
  -- The PO this line resolved to: the inward PO it created, or the existing PO
  -- it was received against. Nullable only so a failed FK can't lose the line.
  po_id           INT           NULL,
  link_type       ENUM('created','received') NOT NULL
                  COMMENT 'created = new inward PO raised; received = booked against an existing PO',
  sku_code        VARCHAR(50)   NULL COMMENT 'Mapped SKU after review',
  parsed_sku_code VARCHAR(100)  NULL COMMENT 'Item code exactly as printed, pre-mapping',
  sku_name        VARCHAR(500)  NULL,
  batch           VARCHAR(100)  NULL,
  mfg_date        VARCHAR(20)   NULL COMMENT 'As printed; often month-only (e.g. Jun-2026), so not a DATE',
  expiry          VARCHAR(20)   NULL COMMENT 'As printed; see mfg_date',
  hsn             VARCHAR(20)   NULL,
  qty             DECIMAL(12,3) NOT NULL,
  rate            DECIMAL(12,4) NULL,
  mrp             DECIMAL(12,4) NULL,
  discount        DECIMAL(12,4) NULL,
  gst_percent     DECIMAL(6,3)  NULL COMMENT 'Tax rate, e.g. 18 — not the tax amount',
  amount          DECIMAL(14,4) NULL COMMENT 'rate x qty, before tax',
  total_amount    DECIMAL(14,4) NULL COMMENT 'Line total incl. tax',
  UNIQUE KEY uq_invoice_line (invoice_id, line_no),
  KEY idx_supplier_invoice_items_po (po_id),
  CONSTRAINT fk_supplier_invoice_items_invoice
    FOREIGN KEY (invoice_id) REFERENCES supplier_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_invoice_items_po
    FOREIGN KEY (po_id) REFERENCES purchase_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
