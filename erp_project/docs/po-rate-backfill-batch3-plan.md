# Backfill unpriced POs from Agreed Final Costing — Kapco, Zymo, Cimera, Yasharth, Arovea (prod)

**Status:** done on prod 2026-10-16. Dry run matched; **34** POs committed (the plan's "33" was a miscount — the table lists 34), 102 `history_pos` rows. Cimera Mcaf401 filled at 86.80 per the agreed-costing rule.

## Context

This is the same method as the Archeesh and Cheryl runs of 2026-10-16:
- POs with no `unit_price`, `amount_pre_gst` or `total_amount` are filled from that manufacturer's **current Agreed Final Costing**;
- the rate comes from `makePoRateResolver()` (`lib/po/po-rate.ts`);
- the amounts come from `poTotal`: the rate rounded to 2 dp, then qty × rate, then × 18% GST, which is the GST on every SKU here.

It is a prod data write on `mcaff_prefg_prod`.

**How the request is read:**
- Kapco: MCaf280_WB.
- Zymo: MCaf387 and MCaf388.
- Cimera: MCFMUBX0428F0250 and Mcaf401.
- Yasharth and Arovea: **every unpriced PO they have.** Neither has a Mcaf401 PO at all, so "Mcaf401 at Yasharth/Arovea" would be empty.
- Mcaf401's unpriced POs at Kain (4) and REV (4) are **not** included.

Every pair is costed with no RM or PM line missing a rate.

## Preview — 33 POs

| Mfg | SKU | Rate | Latest raised PO rate | POs (qty → pre-GST / total) |
|---|---|---|---|---|
| Kapco (4) | MCaf280_WB | 57.84 | 57.84 | MPO-OO113139 15,200 → 879,168.00 / 1,037,418.24 · MPO-OO113421 11,100 → 642,024.00 / 757,588.32 |
| Zymo (15) | MCaf387 | 34.87 | none | MPO-OO113138 20,000 → 697,400.00 / 822,932.00 · MPO-OO113434 12,800 → 446,336.00 / 526,676.48 · MPO-OO113590 4,594 → 160,192.78 / 189,027.48 |
| Zymo (15) | MCaf388 | 59.15 | 59.15 | MPO-OO113295 20,000 → 1,183,000.00 / 1,395,940.00 · MPO-OO113435 (cancelled) 11,300 → 668,395.00 / 788,706.10 |
| Cimera (17) | MCFMUBX0428F0250 | 66.32 | none | MPO-OO113191 50,000 → 3,316,000.00 / 3,912,880.00 |
| Cimera (17) | Mcaf401 | **86.80** | **39.93** (MCAFF-PO-202609-005) | MPO-OO113382 37,400 → 3,246,320.00 / 3,830,657.60 · MPO-OO113556 5,150 → 447,020.00 / 527,483.60 |
| Yasharth (9) | MCaf298_WB | 51.85 | none | 9 POs: MPO-OO12215 (7,700), MPO-OO12456, MPO-OO12697 (4,000 each), MPO-OO12650 (2,500), MPO-OO12780 (7,000), MPO-OO12916 (3,000), MPO-OO113149, MPO-OO113246, MPO-OO113538 (5,000 each) |
| Yasharth (9) | MCaf345_WB | 56.30 | none | MPO-OO12457 (1,200), MPO-OO12698 (1,500), MPO-OO12781 (1,000), MPO-OO113247 (5,000) |
| Arovea (13) | 15MCaf62 | 51.17 | 51.17 | MPO-OO113066 (100,000), MPO-OO113113 (20,000), MPO-OO113229 (40,000), MPO-OO113428 (40,000), MPO-OO113501 (50,000) |
| Arovea (13) | HYPMUBX038F050 | 73.46 | 73.46 | MPO-OO113284 293,600 → 21,567,856.00 / 25,450,070.08 · MPO-OO113374 250,000 → 18,365,000.00 / 21,670,700.00 · MPO-OO113528 361,950 → 26,588,847.00 / 31,374,839.46 |
| Arovea (13) | MCaf53_WB | 40.71 | none | MPO-OO113140 (21,000), MPO-OO113223 (5,800), MPO-OO113592 (7,013), all cancelled |

**What the 33 are:** mostly open (`raised`) and already mailed. 6 are fully received and 4 are cancelled.

Each row's exact amounts are pinned in the script, and the run aborts on any mismatch.

## Flags

1. **Cimera Mcaf401: agreed 86.80 vs 39.93** on Cimera's latest PO (27 Sep, 107,850 units). That is more than double. Per your "agreed costing for all" rule this fills at 86.80, but one of the two numbers is likely wrong.
2. **Kapco MCaf280_WB has no PM wastage row** in Misc Cost. Its 57.84 therefore carries no PM wastage, and it matches the latest Kapco PO anyway.

## Steps (same gates as before)

1. **Snapshot** the 33 rows to the scratchpad.
2. **Dry run**, rolled back. The resolved rates and amounts must equal the preview exactly.
3. **Commit** in one transaction:
   - lock the rows with `FOR UPDATE`;
   - assert `mfg_id` and `po_type = 'normal'`;
   - `UPDATE … WHERE unit_price IS NULL`, expecting 1 row each;
   - add 3 `history_pos` rows per PO (`changed_by = 2`).
4. **Save the plan as `docs/po-rate-backfill-batch3-plan.md`** with its status.

**What doesn't change:** qty, status and receipts. Nothing is re-mailed or sent to Uniware.

## Verification

- These five manufacturers have 0 unpriced normal POs for the SKUs in scope.
- There are 99 new `history_pos` rows (33 × 3).
