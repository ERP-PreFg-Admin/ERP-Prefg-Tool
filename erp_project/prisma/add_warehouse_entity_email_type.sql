-- entity_emails.entity_type: allow 'warehouse' alongside vendor/mfg.
--
-- The inward-invoice mail (lib/mailer.ts → sendInwardInvoiceEmail) resolves its
-- recipients from this table with entity_type='warehouse' and entity_code set
-- to the master_warehouse.name that purchase_orders.destination stores.
--
-- The column was ENUM('vendor','mfg'), so inserting 'warehouse' was silently
-- coerced to '' rather than rejected. Widen it first, then repair anything that
-- already landed blank.
--
-- Applied to the RDS instance on 2026-08-04.

ALTER TABLE entity_emails
  MODIFY COLUMN entity_type ENUM('vendor', 'mfg', 'warehouse') NOT NULL;

UPDATE entity_emails
   SET entity_type = 'warehouse'
 WHERE entity_type = '';
