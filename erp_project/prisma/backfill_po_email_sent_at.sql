-- What: backfill purchase_orders.email_sent_at for every PO that predates the
--       mail-gated status rule.
--
-- Why:  PO Tracking now derives the displayed status from whether the PO has
--       been mailed to the manufacturer — a stored-'raised' PO with no
--       email_sent_at reads back as Draft (DISPLAY_STATUS_EXPR in
--       lib/queries/purchase-orders.ts). Nothing ever wrote email_sent_at
--       before this change, so without this backfill every historical PO in the
--       system would flip to Draft on deploy and lose its Receive / Cancel /
--       Short Close actions.
--
--       The stamp uses the PO date as a proxy for the send time — the real send
--       time was never recorded. Only the drafts are left NULL: those genuinely
--       have not been raised yet.
--
-- Re-runnable: yes. The email_sent_at IS NULL guard means a second run only
--       picks up rows created since the first, which is exactly wrong for POs
--       raised-but-not-yet-mailed under the new rule — so run this ONCE, at
--       deploy time, and not again.
--
-- Run on BOTH schemas (dev and prod).

UPDATE purchase_orders
SET email_sent_at = COALESCE(`date`, CURDATE())
WHERE email_sent_at IS NULL
  AND status <> 'draft';
