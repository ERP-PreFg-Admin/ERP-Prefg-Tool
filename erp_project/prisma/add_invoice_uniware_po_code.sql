-- Records the purchase order code Uniware assigned when the invoice was mirrored.
--
-- We no longer send our own purchaseOrderCode on create: leaving it out lets the
-- facility's own series number the PO (e.g. GM/2627/PO/2006), which is the
-- reference the manufacturer recognises and the one quoted in the notification
-- email. Uniware returns it on the create response, and it exists nowhere else —
-- without storing it there'd be no way to reconcile an invoice against its
-- Uniware PO, or to resend the email with the right reference.
--
-- Nullable because the mirror is skipped when Uniware isn't configured, and
-- because every invoice recorded before this column existed has no code.
--
-- Additive. Run on BOTH schemas (test and prod). Not re-runnable: MariaDB has
-- no ADD COLUMN IF NOT EXISTS, so a second run errors on the duplicate column.
-- Keep prisma/schema.prisma in sync.

ALTER TABLE supplier_invoices
  ADD COLUMN uniware_po_code VARCHAR(64) NULL
    COMMENT 'Purchase order code assigned by Uniware on create'
    AFTER attachment_key,
  ADD KEY idx_supplier_invoices_uniware_po (uniware_po_code);
