-- Every invoice line now raises its own inward PO, including lines that are
-- also received against an existing PO. That gives such a line two related POs,
-- so supplier_invoice_items needs both links:
--
--   po_id                   the inward PO this line raised (always set)
--   received_against_po_id  the pre-existing PO it was booked against, if any
--
-- Previously po_id held whichever of the two applied and link_type said which.
-- link_type is kept: it still distinguishes a plain inward line ('created')
-- from one that also credited an existing order ('received').
--
-- Additive and re-runnable-ish: MariaDB has no ADD COLUMN IF NOT EXISTS for
-- constraints, so a second run errors on the duplicate column — harmless, but
-- check before repeating. Run on BOTH schemas (test and prod).
-- Keep prisma/schema.prisma in sync.

ALTER TABLE supplier_invoice_items
  ADD COLUMN received_against_po_id INT NULL
    COMMENT 'Pre-existing PO this line was received against, when link_type = received'
    AFTER po_id,
  ADD KEY idx_sii_received_against (received_against_po_id),
  ADD CONSTRAINT fk_sii_received_against_po
    FOREIGN KEY (received_against_po_id) REFERENCES purchase_orders (id);

-- Backfill the one shape that existed before: a 'received' line stored the
-- referenced PO in po_id. Move it to the new column; po_id is repopulated with
-- the line's own inward PO from here on, and stays NULL for these legacy rows.
UPDATE supplier_invoice_items
   SET received_against_po_id = po_id,
       po_id = NULL
 WHERE link_type = 'received'
   AND received_against_po_id IS NULL;
