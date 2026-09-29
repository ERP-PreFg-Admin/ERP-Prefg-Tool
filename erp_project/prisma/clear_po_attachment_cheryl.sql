-- Discard the stored PO documents for the six Cheryl POs mailed 2026-09-29.
--
-- WHAT
--   attachment_key := NULL on HYP-PO-202609-002/005/012/016/021 and
--   MCAFF-PO-202609-035.
--
-- WHY
--   poDocument() is write-once: the first send renders the PDF, stores it and
--   stamps attachment_key, and every later send re-attaches those exact bytes.
--   These six were rendered at 09:57 while unit_price was still NULL, so the
--   Rate cell printed "—" (po-document.tsx renders `d.unit_price ? ... : "—"`).
--   The rates landed afterwards. Clearing the key makes the next send render
--   again from current data.
--
--   The S3 objects are deliberately NOT deleted: the key is deterministic
--   (po-documents/YYYY-MM/<po_no>-<id>.pdf), so the re-render overwrites in
--   place, and keeping them loses nothing if this needs unwinding.
--
--   HYP-PO-202609-012 will still show "—": its SKU HYPMUBX0038F0010 has no
--   agreed rate at Cheryl at all, so there is nothing to print.
--
-- NOT re-runnable in the usual sense — it is idempotent (a second run affects
-- 0 rows once the keys are cleared), but running it AFTER a fresh send would
-- discard that send's document too.
--
-- APPLIED TO
--   prod 2026-09-29.

UPDATE purchase_orders
   SET attachment_key = NULL
 WHERE po_no IN (
         'HYP-PO-202609-002', 'HYP-PO-202609-005', 'HYP-PO-202609-012',
         'HYP-PO-202609-016', 'HYP-PO-202609-021', 'MCAFF-PO-202609-035'
       )
   AND attachment_key IS NOT NULL;
