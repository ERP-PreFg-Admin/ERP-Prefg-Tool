-- Stamp unit_price / total_amount on two Cimera POs so they carry a rate.
--
-- WHAT
--   MCAFF-PO-202609-005 (Mcaf401,  qty 107,850) -> 39.93 / 4,306,450.50
--   MCAFF-PO-202609-007 (MCaf370,  qty  56,100) -> 68.17 / 3,824,337.00
--
-- WHY
--   Both were raised before the rate was resolved server-side
--   (lib/po/po-rate.ts), so unit_price was NULL and the PO carried no rate on
--   its document, its mail or the three-way match.
--
-- WHERE THE NUMBERS COME FROM
--   agreedRatesByMfg(17) — the same agreed final cost the invoice match uses.
--   Rounded to paise BEFORE multiplying, so rate x qty equals the amount the
--   PO prints.
--
-- ⚠ Mcaf401's 39.93 is a PARTIAL rate: 8 RM and 5 PM lines on its recipe have
--   no cost master, and selectMaterialCostByMfg counts an unrated line as zero.
--   The true rate is higher — compare MCaf370, a comparable perfume body
--   lotion, at 68.17. Written deliberately (a rate beats no rate), but it will
--   make invoices for this SKU look like an overcharge until those 13 lines
--   are rated. Re-run the numbers and update this row once they are.
--
-- RE-RUNNABLE
--   Yes. `unit_price IS NULL` makes it idempotent; a second run affects 0 rows.
--
-- APPLIED TO
--   prod 2026-09-29.

UPDATE purchase_orders
   SET unit_price = 39.93, total_amount = 4306450.50
 WHERE po_no = 'MCAFF-PO-202609-005' AND unit_price IS NULL;

UPDATE purchase_orders
   SET unit_price = 68.17, total_amount = 3824337.00
 WHERE po_no = 'MCAFF-PO-202609-007' AND unit_price IS NULL;
