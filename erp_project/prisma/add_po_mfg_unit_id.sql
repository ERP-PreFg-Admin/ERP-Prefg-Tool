-- WHAT: purchase_orders.mfg_unit_id — the manufacturer plant a PO is raised against.
-- NULL = fall back to map_mfg_unit_sku, so units-less manufacturers and older POs are unchanged.
-- WHY: the raiser picks the unit per PO; the mapping becomes only the default. See docs/po-mfg-unit-plan.md.
-- No backfill (Ajay, 2026-10-27): applies to POs raised from now on.
--
-- NOT RE-RUNNABLE: MySQL 8 has no ADD COLUMN IF NOT EXISTS. Run on dev, then prod with its own go-ahead,
-- BEFORE the deploy that reads the column.

ALTER TABLE purchase_orders
  ADD COLUMN mfg_unit_id INT NULL AFTER mfg_id,
  ADD KEY idx_po_mfg_unit_id (mfg_unit_id),
  ADD CONSTRAINT fk_po_mfg_unit FOREIGN KEY (mfg_unit_id) REFERENCES details_mfg_unit (id);
