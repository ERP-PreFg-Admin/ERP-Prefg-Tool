# Backfill All Mask's unpriced POs from Agreed Final Costing — plan

**Status:** done on prod 2026-10-16. The dry run matched; 15 unpriced POs were committed, with 45 `history_pos` rows. (The first draft said 20; that was an addition error, and 15 is correct.)

## Context

This is the same method as the Archeesh, Cheryl, batch-3 and Samarvir runs of 2026-10-16:
- the rate comes from `makePoRateResolver()`;
- the amounts come from `poTotal`, at 18% GST, which is the GST on every SKU here;
- the run is one transaction, after a dry run that must match this preview exactly;
- each PO gets 3 `history_pos` rows (`changed_by = 2`), and the rows are snapshotted first.

**Scope:** every unpriced normal PO at All Mask (`MFG-011-ALL`, mfg_id 11), meaning `unit_price`, `amount_pre_gst` and `total_amount` are all NULL. **Mcaf177 is excluded** (MPO-OO12895, MPO-OO113231, MPO-OO113411). No priced PO is touched.

That leaves **15 POs over 6 SKUs**. All 6 are fully costed, with 0 RM or PM lines unrated.

## Preview — 15 POs

| SKU | Rate | Latest PO rate | PO → qty → pre-GST / total |
|---|---|---|---|
| 15MCaf177 | 76.01 | 75.99 | MPO-OO113242 → 32,500 → 2,470,325.00 / 2,914,983.50 · MPO-OO113349 → 30,200 → 2,295,502.00 / 2,708,692.36 · MPO-OO113500 → 7,200 → 547,272.00 / 645,780.96 |
| 15MCaf225 | 76.01 | 75.99 | MPO-OO113241 → 20,000 → 1,520,200.00 / 1,793,836.00 · MPO-OO113350 → 5,000 → 380,050.00 / 448,459.00 |
| 15MCaf262 | 80.00 | 79.99 | MPO-OO113240 → 5,000 → 400,000.00 / 472,000.00 · MPO-OO113351 → 6,200 → 496,000.00 / 585,280.00 |
| 15MCaf263 | 80.00 | 79.99 | MPO-OO113243 → 5,000 → 400,000.00 / 472,000.00 |
| 40MCaf272 | 57.26 | 57.25 | MPO-OO12902 (received) · MPO-OO113166 (received) · MPO-OO113238, each → 5,000 → 286,300.00 / 337,834.00 · MPO-OO113511 → 3,300 → 188,958.00 / 222,970.44 |
| HYPMUBX036F050 | 82.01 | none | MPO-OO12814 → 4,500 → 369,045.00 / 435,473.10 · MPO-OO12943 → 3,600 → 295,236.00 / 348,378.48 · MPO-OO113400 → 3,200 → 262,432.00 / 309,669.76 |

Agreed costing is 1–2 paise above each SKU's latest PO (MCAFF-PO-202609-0xx, raised 28 Sep). This is either rounding or a small cost-master move since then. Per your rule, agreed costing is used.

## Not in scope (flag only)

Three inward POs have **qty and rate swapped**:

| Inward PO | SKU | Stored qty | Stored rate |
|---|---|---|---|
| MPO-INW-202610-166 | 15MCaf262 | 80 | 2,560 |
| MPO-INW-202610-167 | 15MCaf263 | 76 | 2,500 |
| MPO-INW-202610-138 | 40MCaf272 | 57.25 | 2,016 |

Each one is a duplicate of a correct sibling (-169, -170 and -118). The totals match, so this is likely a parse error that was inwarded twice. These POs are already priced, so this run leaves them alone. Worth a separate look.

## Gates

1. Ajay's go-ahead.
2. Dry run, rolled back, which must match the preview.
3. Commit.
4. Verify:
   - All Mask has 0 unpriced normal POs except the 3 Mcaf177 POs;
   - there are 45 new `history_pos` rows.
