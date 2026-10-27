-- What: purchase_orders.status gains 'discarded' — a Draft PO (approved, never mailed)
--       withdrawn before the manufacturer ever saw it. Distinct from 'cancelled', which
--       is an order withdrawn after it was sent. See docs/po-discard-draft-plan.md.
-- Appended at the end: no existing value's ordinal moves, so no row is rewritten.
-- Re-runnable: MODIFY to the same definition is a no-op in effect.
-- Run on dev, then prod with its own go-ahead; keep prisma/schema.prisma in sync.

-- Pre-check (expect exactly this list, default 'draft'):
--   draft, raised, punched, short_closed, partially_received, received, cancelled, rejected, reverted
SHOW COLUMNS FROM purchase_orders LIKE 'status';

ALTER TABLE purchase_orders
  MODIFY COLUMN status ENUM('draft','raised','punched','short_closed','partially_received',
                            'received','cancelled','rejected','reverted','discarded') NOT NULL DEFAULT 'draft';

-- Reversal (only while no row is 'discarded', or MySQL coerces them to ''):
-- ALTER TABLE purchase_orders MODIFY COLUMN status ENUM('draft','raised','punched','short_closed',
--   'partially_received','received','cancelled','rejected','reverted') NOT NULL DEFAULT 'draft';
