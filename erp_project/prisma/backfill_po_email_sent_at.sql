-- Stamp email_sent_at on the historical POs backfilled into prod on 2026-09-28.
--
-- WHAT
--   ids 432-753: 322 rows, status 'raised', po_type 'normal', po_no MPO-OO*.
--   email_sent_at := po.date (the PO's own business date).
--
-- WHY
--   DISPLAY_STATUS_EXPR reads a stored-'raised' PO with no email_sent_at back as
--   Draft, on the rule that a PO the manufacturer has not been told about is not
--   really raised. These were communicated outside the ERP before the backfill,
--   so the stamp records a fact rather than inventing one. Without it they show
--   as Draft in PO Tracking and are excluded from the low-open-PO alert, which
--   deliberately ignores drafts as "not incoming supply".
--
-- WHY po.date AND NOT NOW()
--   NOW() would make the 23:59 digest report "322 POs mailed today" — false, and
--   permanently so. po.date keeps every day's count honest.
--
-- SCOPE
--   The id range is the discriminator: 432-753 is the contiguous block inserted
--   by the backfill, running up to MAX(id). Ids 123 and 382 are unstamped
--   raised/normal POs from EARLIER imports and are deliberately excluded — id 122,
--   same batch and date as 123, was stamped at the time, so that pair was already
--   handled by hand.
--
-- RE-RUNNABLE
--   Yes. `email_sent_at IS NULL` makes it idempotent; a second run affects 0 rows.
--
-- APPLIED TO
--   prod 2026-09-28. Not applicable to dev/test, which have no such backfill.

UPDATE purchase_orders
   SET email_sent_at = date
 WHERE id BETWEEN 432 AND 753
   AND email_sent_at IS NULL
   AND status = 'raised'
   AND COALESCE(po_type, '') = 'normal';
