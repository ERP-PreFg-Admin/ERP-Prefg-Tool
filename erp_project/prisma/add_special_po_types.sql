-- What: purchase_orders.po_type gains 'npd', 'tech_transfer', 'cpr' — the special PO
--       types raised at price 0 from the bulk upload. See docs/po-bulk-type-plan.md.
-- Why:  MySQL rejects an ENUM value it doesn't list, so this must land before the code.
-- Safety: values appended at the end, so no existing ordinal moves; default unchanged.
-- Re-runnable: yes (a MODIFY to the same definition is a no-op).
-- Run on dev first; prod on its own go-ahead, BEFORE the deploy.

ALTER TABLE purchase_orders
  MODIFY COLUMN po_type ENUM('normal','impromptu','inward','npd','tech_transfer','cpr') DEFAULT 'impromptu';

-- Verify:
--   SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'po_type';
