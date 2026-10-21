# Fix the qty / rate swap on invoice JIPL/26-27//5179 — plan

**Status:** done on prod 2026-10-19. The dry run matched and the change is committed. Read-back: line 751 is now 2,016 at 57.25; MPO-INW-202610-138 is 2,016 at 57.25; MPO-OO113238 has 2,146 received. 4 `history_pos` rows were added.

## What's wrong

Invoice **JIPL/26-27//5179** (All Mask, 6 Oct, Gurgaon, invoice id 352) was inwarded on 8 Oct with its one line's **qty and rate swapped**:

| | Stored | Correct |
|---|---|---|
| Qty (40MCaf272) | 57.25 | **2,016** |
| Rate | 2,016 | **57.25** |
| Amount | 115,416 | 115,416 (unchanged) |

Evidence:
- Uniware GRNed **2,016** units on GM/2627/PO/2611 (G7863 for 2,015 and G7864 for 1).
- The rate matches All Mask's 57.25 on the earlier invoice 5174.
- The agreed rate is 57.26.

This is **not a duplicate**. JIPL/26-27//5174 is a separate, correctly booked invoice for 2,016 units to Mumbai.

## Fix — prod DB only, one transaction

| # | Row | Change |
|---|---|---|
| 1 | `invoice_items_mfg` 751 | qty 57.25 → **2,016**, rate 2,016 → **57.25** |
| 2 | `purchase_orders` 1195, MPO-INW-202610-138 | qty and received_qty 57.25 → **2,016**, unit_price 2,016 → **57.25** |
| 3 | `purchase_orders` 548, MPO-OO113238 | received_qty 187.25 → **2,146** (130 from invoice 5174 + 2,016) |

- Every PO field change gets a `history_pos` row (`changed_by = 2`).
- The rows are snapshotted first.
- Each UPDATE is guarded on the current wrong value, so a re-run changes nothing.

**No changes to:**
- MPO-OO113238's status, which stays raised: 2,146 of 5,000 received;
- the invoice header and totals;
- Uniware, which already has 2,016;
- email.

**FIFO check:** with the correct 2,016, the receipt still lands entirely on MPO-OO113238. 4,870 was still open there, and the two older POs were already fully received.

## Gates

1. Ajay's go-ahead.
2. Dry run, rolled back.
3. Commit.
4. Read back the three rows and their history.

## Follow-up (not in this fix)

There are two more inward POs with the same swap. Each would need the same check against its own invoice and Uniware GRN:
- MPO-INW-202610-166 (15MCaf262: 80 at 2,560);
- MPO-INW-202610-167 (15MCaf263: 76 at 2,500).

The parser letting qty and rate swap on these All Mask (JIPL) invoices is the root cause, and is worth a separate look.
