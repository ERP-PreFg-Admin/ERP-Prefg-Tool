-- What: index purchase_orders.reference_po.
--
-- Why:  split children point at their parent through this column, and the PO
--       list now LEFT JOINs a child aggregate keyed on it (CHILD_AGG_JOIN in
--       lib/queries/purchase-orders.ts) on every page load, tab count, summary
--       card and export. Unindexed it is a full scan of purchase_orders per
--       query. It is also the column the masters-only filter tests.
--
-- Re-runnable: NO. MySQL 8.0 has no CREATE INDEX IF NOT EXISTS; a second run
--       fails with ER_DUP_KEYNAME, which is harmless but noisy. Check with
--       SHOW INDEX FROM purchase_orders WHERE Key_name = 'idx_po_reference_po';
--
-- Run on BOTH schemas (dev and prod), and keep prisma/schema.prisma in sync.

CREATE INDEX idx_po_reference_po ON purchase_orders (reference_po);
