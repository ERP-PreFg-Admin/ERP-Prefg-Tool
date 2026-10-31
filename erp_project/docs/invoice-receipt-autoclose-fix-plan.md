# Invoice save refused when several lines settle one PO

Status: steps 1–4 done 2026-10-31. Awaiting commit and prod deploy.
- `tests/db/invoice-multiline-receipt.test.ts` passes on the fix and fails on the old code with the prod error.
- The revert case is covered in that test, not by a manual dev run.

## The bug
- **Reported:** Yogesh could not save RP/L/26-27/1559 (Reve) against MPO-OO113554. It was rolled back 8 times, 13:22–13:32 UTC, with "Cannot receive against PO MPO-OO113554 — its status is 'received'".
- **Cause:** `lib/invoice/invoice-inward.ts:188` calls `receivePo()` once **per invoice line**.
  - `receivePo` auto-closes a PO as soon as the open quantity is within `poTolerance` (`lib/po/po-receive.ts:102`, which is min(100, 10%)).
  - When several lines (batches) land on one PO, an early line can close it, and the next line is then refused (`po-receive.ts:61`). The whole invoice rolls back.
- **This case:**
  - The PO was for 9,500 with 1,920 received, so 7,580 was open.
  - FIFO gave it 1,890 × 4 plus 20 from the fifth batch.
  - After the fourth batch 20 was left, within the tolerance of 100, so the PO closed. The 20 was then refused.
- **Who hits it:** any multi-batch invoice whose FIFO share ends within tolerance of a PO's balance. Common with Reve and MBA, which print one line per batch.

## The fix
Book the receipt **once per PO per invoice**, not once per line.
1. Before the line loop in `invoiceInward`, sum each `reference_po_id`'s quantity across the invoice's lines.
2. On the first line for a PO, call `receivePo(conn, poId, total, userId)` with the summed quantity and keep the result. Later lines for that PO reuse the result and do not call it again.
3. Everything else stays as it is:
   - one `invoice_items_mfg` row per printed line, with its own `received_against_po_id`;
   - inward POs merged by SKU;
   - the over-limit check and auto-close inside `receivePo`. Close-out is now decided on the invoice's full share, which is the intended behaviour.

`receivePo` itself is unchanged, so the manual Receive dialog is unaffected.

## What changes as a side effect
- **History:**
  - `history_pos` gets **one** `received_qty` row per PO per invoice instead of one per line.
  - The PO's history panel shows a single step (1,920 → 9,500) rather than five.
  - The per-line detail is still in `invoice_items_mfg`.
- **Revert:** `lib/invoice/invoice-revert.ts` reverses from the invoice lines, not from history rows. It needs a check, not a change.
- **Traceability plan (T4, receipt events):** an invoice receipt becomes one delta equal to the **sum** of that PO's lines on the invoice, not one delta per line. T4's matcher must match on the summed quantity. I'll note this in `docs/reporting/traceability-plan.md` when T4 is built.

## Sequencing and gates
| # | Step | Gate |
|---|---|---|
| 1 | Change the receipt loop in `invoice-inward.ts` (about 10 lines) | `tsc --incremental false`, `lint:changed` |
| 2 | DB test in `tests/db/`: PO for 9,500 with 1,920 received; invoice with 5 lines of 1,890 split 7,580 / 1,870 across two POs | Commits. First PO is `received` at 9,500, second at 1,870. One history row each, 5 item rows. The same test fails on today's code |
| 3 | Existing DB tests: `po-receive`, `invoice-revert`, `report-invoice-checks` | `npm run test:db` green |
| 4 | Dev run: revert an invoice with multi-line receipts on one PO | Received qty returns to the pre-invoice value |
| 5 | Commit, then prod deploy | Ajay |
| 6 | Yogesh re-saves RP/L/26-27/1559 | The invoice exists. MPO-OO113554 shows 9,500 `received`, MCAFF-PO-202609-042 shows 1,870 |

## Until it ships
Yogesh can save today by setting batch MCBS-1353's Reference PO to MCAFF-PO-202609-042 on the review screen. MPO-OO113554 then takes 7,560 and closes within tolerance.

## Risks
- **Revert parity:** if any revert path does read `history_pos` deltas, one combined row could under-reverse. Step 4 is the check.
- **No prod data to fix:** every failed attempt rolled back, so nothing is half-booked. The only residue is 8 orphan PDF copies in S3, which the app user can't delete.

## Out of scope
- The tolerance rule itself.
- The FIFO allocator.
- The orphan S3 copies.
