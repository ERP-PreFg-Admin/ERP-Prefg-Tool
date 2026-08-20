-- invoice_mfg.uniware_status — the PO status Unicommerce reports for
-- uniware_po_code, as of uniware_synced_at.
--
-- On the invoice, not on purchase_orders: Uniware holds ONE PO per invoice, so
-- the status describes the document. The inward PO list reads it back through
-- po.uniware_po_code (a scalar subquery in SELECT_COLS), which keeps one writer
-- and one row to update per refresh — a status CHANGES, unlike the code beside
-- it, and copying a changing value onto every inward PO of an invoice would be
-- N rows that can disagree with each other.
--
-- VARCHAR, not an enum: these are Unicommerce's status names, and a new one
-- appearing on their side must not be a migration on ours.
--
-- Both NULL until someone hits Sync. Never-synced and no-status are not the
-- same thing, which is what uniware_synced_at is for — the UI reads a NULL
-- timestamp as "never synced" rather than as a stale value.
--
-- Applied to the RDS instance on <fill in>.

ALTER TABLE invoice_mfg
  ADD COLUMN uniware_status    VARCHAR(40) NULL AFTER uniware_po_code,
  ADD COLUMN uniware_synced_at DATETIME    NULL AFTER uniware_status;
