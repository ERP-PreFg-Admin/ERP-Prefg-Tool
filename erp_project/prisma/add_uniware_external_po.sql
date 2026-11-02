-- What: uniware_external_po, a read-only cache of Uniware POs at our facilities that no ERP invoice owns.
--
-- Why:  POs keyed by hand in Uniware never reach invoice_mfg (docs/uniware-manual-po-plan.md). The sweep
--       caches every code it details, so a re-run only details new ones; Add Invoice adopts a row by linking to it.
--       Replacement / missing / not-FG is derived at read time (lib/uniware/external-po.ts), not stored.
--
-- Re-runnable: yes (CREATE TABLE IF NOT EXISTS).
--
-- Applied to mcaff_prefg_dev and mcaff_prefg_prod on 2026-11-02.

CREATE TABLE IF NOT EXISTS uniware_external_po (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  uniware_po_code    VARCHAR(64)  NOT NULL,
  facility_code      VARCHAR(50)  NOT NULL,
  vendor_code        VARCHAR(100) NULL,
  mfg_id             INT NULL COMMENT 'Resolved from vendor_code at the facility, NULL = not one of our manufacturers',
  reference_no       VARCHAR(100) NULL COMMENT 'Uniware ReferenceNo custom field: the invoice number',
  un_status          VARCHAR(40)  NULL,
  grn_count          INT NULL,
  un_created_by      VARCHAR(255) NULL,
  un_created_at      DATETIME     NULL,
  all_fg             TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'Every line is a master_skus code',
  items              JSON         NOT NULL COMMENT '[{sku_code, qty, unit_price, mrp}]',
  adopted_invoice_id INT NULL,
  first_seen_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_uniware_external_po_code (uniware_po_code),
  UNIQUE KEY uq_uniware_external_po_invoice (adopted_invoice_id),
  KEY idx_uniware_external_po_mfg (mfg_id, adopted_invoice_id),
  KEY idx_uniware_external_po_ref (reference_no),
  CONSTRAINT fk_uniware_external_po_mfg FOREIGN KEY (mfg_id) REFERENCES master_mfgs (id),
  CONSTRAINT fk_uniware_external_po_invoice FOREIGN KEY (adopted_invoice_id) REFERENCES invoice_mfg (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Verify
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uniware_external_po' ORDER BY ORDINAL_POSITION;
