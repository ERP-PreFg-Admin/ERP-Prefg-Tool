-- Adds 'inward' to purchase_orders.po_type, for POs auto-raised from a parsed
-- supplier invoice on the PO Inwarding page (see AddInvoiceDialog).
--
-- Additive ENUM change: existing rows keep their 'normal'/'impromptu' value and
-- the DEFAULT is unchanged, so this is safe to run on a live table. MODIFY
-- rewrites the column definition wholesale, so the full value list has to be
-- restated — dropping one would silently blank those rows.
--
-- Re-running is a harmless no-op. Run on BOTH schemas (test and prod).
-- Keep prisma/schema.prisma's `purchase_orders_type` enum in sync.

ALTER TABLE purchase_orders
  MODIFY COLUMN po_type ENUM('normal','impromptu','inward') DEFAULT 'impromptu';
