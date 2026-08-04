-- purchase_orders.uniware_po_code — maps our PO number to the Unicommerce PO.
--
-- Our model is one PO per SKU; Uniware's mirror is one PO carrying every SKU on
-- the invoice, so a whole invoice's inward POs share one code. It is stamped on
-- each row (rather than joined from supplier_invoices) so the PO list — the
-- hottest query on this table — doesn't grow a join, and so the code survives
-- alongside the PO it belongs to.
--
-- NULL for every non-inward PO, and for inward POs raised while Uniware was
-- unconfigured or down.
--
-- Applied to the RDS instance on 2026-08-04.

ALTER TABLE purchase_orders
  ADD COLUMN uniware_po_code VARCHAR(64) NULL AFTER invoice_no;

-- Backfill the inward POs already created, via the invoice line that raised each.
UPDATE purchase_orders po
  INNER JOIN supplier_invoice_items sii ON sii.po_id = po.id
  INNER JOIN supplier_invoices si       ON si.id     = sii.invoice_id
   SET po.uniware_po_code = si.uniware_po_code
 WHERE si.uniware_po_code IS NOT NULL
   AND po.uniware_po_code IS NULL;

