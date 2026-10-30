-- What: invoice_mfg.freight_amount + freight_tax, the invoice-level charges (freight, packing, insurance…) summed.
--
-- Why:  the invoice export shows freight pre and post GST (docs/invoice-export-freight-plan.md). The parser
--       already reads charges but the commit discarded them. NULL = not known (scanned PDF / pre-backfill), not 0.
--
-- Re-runnable: NO (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
--
-- Applied to mcaff_prefg_dev and mcaff_prefg_prod on 2026-10-30. Prod freight backfill: scripts/backfill-invoice-freight.ts.

ALTER TABLE invoice_mfg
  ADD COLUMN freight_amount DECIMAL(14,4) NULL AFTER invoice_total,
  ADD COLUMN freight_tax    DECIMAL(14,4) NULL AFTER freight_amount;
