# Backfill Cheryl's unpriced POs from Agreed Final Costing — plan

**Status:** done on prod 2026-10-16. Ajay chose agreed costing for all, D1 and D2 included, and D3 fixed. The dry run matched the preview; 16 POs were committed, with 46 `history_pos` rows.

## Context

Cheryl (`MFG-001-CHE`, mfg_id 1) POs for ten SKUs carry no `unit_price`, `amount_pre_gst` or `total_amount`. Fill them from Cheryl's current Agreed Final Costing. This is the same method as the Archeesh run of 2026-10-16:
- the rate comes from `makePoRateResolver()` (`lib/po/po-rate.ts`);
- the amounts come from `poTotal`, at 18% GST.

**Only Cheryl POs.** HYPMUBX0046F0030 also has 4 unpriced POs at mfg 16, and those are left alone.

All ten SKUs are **fully costed** at Cheryl: every RM and PM line has a rate, and every required misc cost is present.

## How this differs from Archeesh

**The Archeesh POs were all cancelled. These are not:**
- 13 of the 14 are **open** (`raised`), and most were already mailed;
- 1 is fully received (MPO-OO113291).

What changes is the value the ERP shows and exports for them. **Nothing is re-mailed or sent to Uniware**, so the manufacturer's copy is not touched.

## Gates

1. **Ajay answers D1–D3.**
2. **Dry run**, rolled back. It must match the preview exactly.
3. **Commit**, in one transaction. A snapshot of the rows goes to the scratchpad first.
4. **Verify:**
   - the filled POs carry the values below;
   - there are 3 `history_pos` rows per PO;
   - no other PO changed.

## Preview — 14 unpriced Cheryl POs

| PO | SKU | Status | Qty | Rate | Pre-GST | Total |
|---|---|---|---|---|---|---|
| MPO-OO12870 | DNDMUBX0005F0050 | raised | 15,000 | 73.63 | 1,104,450.00 | 1,303,251.00 |
| MPO-OO12871 | DNDMUBX0006F0050 | raised | 15,000 | 72.74 | 1,091,100.00 | 1,287,498.00 |
| MPO-OO113599 | HYPMUBX0038F0010 | raised | 49,000 | **28.62** | 1,402,380.00 | 1,654,808.40 |
| MPO-OO113168 | HYPMUBX0046F0010 | raised | 100,000 | 28.99 | 2,899,000.00 | 3,420,820.00 |
| MPO-OO113291 | HYPMUBX0046F0030 | received | 95,500 | 79.50 | 7,592,250.00 | 8,958,855.00 |
| MPO-OO113515 | HYPMUBX0046F0030 | raised | 65,830 | 79.50 | 5,233,485.00 | 6,175,512.30 |
| MPO-OO113043 | HYPMUBX004F050 | raised | 100,000 | 80.85 | 8,085,000.00 | 9,540,300.00 |
| MPO-OO113378 | HYPMUBX004F050 | raised | 127,200 | 80.85 | 10,284,120.00 | 12,135,261.60 |
| MPO-OO113587 | HYPMUBX004F050 | raised | 7,300 | 80.85 | 590,205.00 | 696,441.90 |
| MPO-OO113309 | HYPMUBX0054F0040 | raised | 150,000 | 76.66 | 11,499,000.00 | 13,568,820.00 |
| MPO-OO12725 | HYPMUBX020F030 | raised | 27,000 | **64.78** | 1,749,060.00 | 2,063,890.80 |
| MPO-OO113393 | HYPMUBX020F030 | raised | 8,500 | **64.78** | 550,630.00 | 649,743.40 |
| MPO-OO113335-S001 | MCFMUBX0433F0040 | raised | 20,000 | 75.97 | 1,519,400.00 | 1,792,892.00 |
| MPO-OO113335-S002 | MCFMUBX0433F0040 | raised | 20,000 | 75.97 | 1,519,400.00 | 1,792,892.00 |

**MCFMUBX0429F0200 has no unpriced Cheryl PO.** All three of its POs already carry 88.35.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | HYPMUBX0038F0010: agreed costing is **28.62**, but the latest PO (HYP-PO-202609-012, 27 Sep) was raised at **21.62**. That is a ₹7 gap, about 32%, so a cost master changed after 27 Sep or the old PO was wrong. Use 28.62? | **Check the cost master before filling.** A gap that size suggests one rate in the recipe is off |
| D2 | HYPMUBX020F030: agreed is **64.78**, and the latest PO (HYP-PO-202609-021) was **60.05**. Use 64.78? | Use 64.78, per your rule of agreed costing, unless D1's check finds the same cause |
| D3 | MPO-OO113471 (HYPMUBX0046F0030) and MPO-OO113192 (MCFMUBX0429F0200) have a rate but **no `amount_pre_gst`**. Their stored `total_amount` is exactly qty × rate (10,925,093.76 and 2,650,500.00), so it is really the **pre-GST** figure, with no GST on it. Fix: `amount_pre_gst` = that figure, `total_amount` = ×1.18 (12,891,610.64 and 3,127,590.00)? | **Yes**, as a separate item. The rate isn't changed, but the total each PO reports goes up by 18% |

The split children MPO-OO113335-S001/S002 get 75.97. That matches their parent MPO-OO113335's own rate, so there's no conflict.
