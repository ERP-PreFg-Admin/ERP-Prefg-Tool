-- purchase_orders.remarks — the "Reason / Notes" typed when a PO is raised.
--
-- Until now this lived only as an approval_items row (field_name = 'reason'),
-- which meant: normal POs discarded it entirely, and an impromptu PO's reason
-- was reachable only by finding its approval. It is a property of the order, so
-- it belongs on the order. Also settable from the bulk CSV.
--
-- VARCHAR(300) NULL, matching every other `remarks` column in this schema
-- (see add_remarks_columns.sql).
--
-- MySQL 8.0: no ADD COLUMN IF NOT EXISTS — not re-runnable.
-- Run on BOTH schemas.

ALTER TABLE purchase_orders
  ADD COLUMN remarks VARCHAR(300) NULL AFTER destination;

-- Backfill: recover the reasons already captured on impromptu POs' approvals.
-- One approval_item per changed field, so this joins to exactly the 'reason'
-- row. A PO re-edited more than once has several; MAX() picks one rather than
-- letting the UPDATE pick arbitrarily.
UPDATE purchase_orders po
   SET po.remarks = (
     SELECT LEFT(MAX(ai.new_value), 300)
       FROM approvals ap
       INNER JOIN approval_items ai ON ai.approval_id = ap.id
      WHERE ap.module     = 'PO'
        AND ap.entity_id  = po.id
      AND ai.field_name = 'reason'
        AND ai.new_value IS NOT NULL
        AND ai.new_value <> ''
   )
 WHERE po.remarks IS NULL;
