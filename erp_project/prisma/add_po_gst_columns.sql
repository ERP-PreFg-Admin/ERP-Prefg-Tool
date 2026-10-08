-- What: purchase_orders gains amount_pre_gst (unit_price × qty); total_amount becomes
--       GST-inclusive, at the SKU's master_skus.gst. The GST % is not stored — it
--       is implied by the two amounts (total / amount_pre_gst − 1).
-- Why:  the PDF added a flat 18% to a pre-GST total whatever the SKU; 12 prod POs
--       are on 5% SKUs. See docs/po-total-gst-plan.md.
-- Scope: non-inward POs with a total. Inward POs mirror the supplier invoice — untouched.
-- Re-runnable: the ALTER is NOT (MySQL 8 has no ADD COLUMN IF NOT EXISTS). The UPDATE
--       is guarded by amount_pre_gst IS NULL, so a second run cannot add GST twice.
-- Run on dev first; prod on its own go-ahead, BEFORE the deploy, AFTER the GST master
-- clean-up — the backfill applies master_skus.gst as it stands.

ALTER TABLE purchase_orders
  ADD COLUMN amount_pre_gst DECIMAL(14,4) NULL AFTER unit_price;

-- Today's total IS the pre-GST amount.
UPDATE purchase_orders po
LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
SET po.amount_pre_gst = po.total_amount,
    po.total_amount   = ROUND(po.total_amount * (1 + COALESCE(sk.gst, 18) / 100), 2)
WHERE COALESCE(po.po_type, '') <> 'inward'
  AND po.total_amount IS NOT NULL
  AND po.amount_pre_gst IS NULL;

-- Verify (expect 0 rows): the implied GST % equals the SKU's.
--   SELECT po.po_no FROM purchase_orders po JOIN master_skus sk ON sk.sku_code = po.sku_code
--    WHERE po.amount_pre_gst > 0
--      AND ABS(po.total_amount - ROUND(po.amount_pre_gst * (1 + COALESCE(sk.gst,18)/100), 2)) > 0.01;
