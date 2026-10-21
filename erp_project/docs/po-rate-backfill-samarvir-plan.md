# Backfill Samarvir's unpriced POs from Agreed Final Costing — plan

**Status:** done on prod 2026-10-16. The dry run matched; 23 unpriced POs were committed, with 69 `history_pos` rows. D1: the 3 SKUs were skipped. D2: not done, because Ajay said no priced PO is to be changed, so MCAFF-PO-202610-004 stays at 0.57.

## Context

This is the same method as the Archeesh, Cheryl and batch-3 runs of 2026-10-16:
- the rate comes from `makePoRateResolver()`;
- the amounts come from `poTotal`, at 18% GST, which is the GST on every SKU here;
- the run is one transaction, after a dry run that must match this preview exactly;
- each PO gets 3 `history_pos` rows (`changed_by = 2`), and the rows are snapshotted first.

**Scope:** every unpriced normal PO at Samarvir (`MFG-016-SAM`, mfg_id 16) **except HYPMUBX0046F0030**, as Ajay asked.

That is 26 POs. 23 can be filled; 3 can't (D1).

## Preview — 23 POs

| SKU | Rate | Latest PO rate | PO → qty → pre-GST / total |
|---|---|---|---|
| HYPMUBX0066F0050 | 72.88 | 72.88 | MPO-OO113310 → 110,000 → 8,016,800.00 / 9,459,824.00 |
| HYPMUBX017F100 | 37.41 | 37.41 | MPO-OO113391 → 70,300 → 2,629,923.00 / 3,103,309.14 · MPO-OO113524 → 30,300 → 1,133,523.00 / 1,337,557.14 · MPO-OO113601 → 30,000 → 1,122,300.00 / 1,324,314.00 |
| HYPMUBX017F200 | 57.02 | 57.02 | MPO-OO113285 (received) → 20,000 → 1,140,400.00 / 1,345,672.00 · MPO-OO113392 → 48,600 → 2,771,172.00 / 3,269,982.96 · MPO-OO113525 → 20,000 → 1,140,400.00 / 1,345,672.00 · MPO-OO113602 → 15,000 → 855,300.00 / 1,009,254.00 |
| HYPMUBX030F050 | 86.00 | 86.00 | MPO-OO12941 (received) → 15,100 → 1,298,600.00 / 1,532,348.00 · MPO-OO113150 (received) → 10,000 → 860,000.00 / 1,014,800.00 · MPO-OO113281 → 5,000 → 430,000.00 / 507,400.00 · MPO-OO113397 → 7,800 → 670,800.00 / 791,544.00 |
| HYPMUBX031F018 | 107.13 | 108.15 | MPO-OO113398 → 5,000 → 535,650.00 / 632,067.00 |
| HYPMUWB0017F0015_N1 | 14.87 | 14.87 | MPO-OO113476 → 453,536 → 6,744,080.32 / 7,958,014.78 |
| MCaf221_N | 33.11 | 33.11 | MPO-OO12651 → 2,000 → 66,220.00 / 78,139.60 |
| MCaf299 | 43.42 | 43.42 | MPO-OO113135 (received) → 10,000 → 434,200.00 / 512,356.00 · MPO-OO113245 → 20,000 → 868,400.00 / 1,024,712.00 · MPO-OO113423 → 24,600 → 1,068,132.00 / 1,260,395.76 · MPO-OO113539 → 5,000 → 217,100.00 / 256,178.00 |
| MCaf83_N | 33.11 | 33.11 | MPO-OO113456 → 15,300 → 506,583.00 / 597,767.94 |
| MCFMUBX0427F0050 | 69.12 | 68.38 | MPO-OO113193 → 60,000 → 4,147,200.00 / 4,893,696.00 |
| MCFMUBX0430F0050 | 73.25 | **0.57** | MPO-OO113189 (cancelled) → 50,000 → 3,662,500.00 / 4,321,750.00 |
| MCFMUBX0431F0050 | 70.68 | 70.67 | MPO-OO113326 → 50,000 → 3,534,000.00 / 4,170,120.00 |

Every rate above is fully costed: no RM or PM line is missing a rate.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Three SKUs have no usable agreed rate. **HYPMUBX0067F0030** comes to 2.58, with 18 RM and 2 PM lines unrated. **MCFMUBX0432F0100** comes to 0.12, with 17 RM and 5 PM lines unrated. **HYPMUBX031F030** has no recipe at Samarvir. Their POs are MPO-OO113311, MPO-OO113190 and HYP-PO-202609-037 | **Skip all three.** A 2.58 or 0.12 rate is a cost-master gap, not a price |
| D2 | **MCAFF-PO-202610-004 (MCFMUBX0430F0050, raised 4 Oct) carries 0.57**, against 73.25 agreed. It's open, with 22,892 received. It was almost certainly raised while that SKU was only partly costed | Out of scope here. **Re-price it to 73.25 as a separate fix**, if you agree |

## Note

MPO-OO113392 is the PO the SB/2329 and SB/2330 invoices were removed from (2026-10-15). Its `received_qty` (now 22,253) isn't touched here.
