# Backfill unpriced POs: Kain and ADF (prod)

**Status:** done on prod 2026-10-23. 10 POs were filled at the agreed rate and 30 `history_pos` rows were added. Afterwards, 0 unpriced POs remain for these SKUs. Priced POs were not touched.

This uses the same method as the earlier batches (Archeesh, Cheryl, batch 3, All Mask):
- Each unpriced PO gets the rate from that manufacturer's current Agreed Final Costing (`makePoRateResolver`).
- The amounts are qty × rate, then × 18% GST.
- The writes go to `mcaff_prefg_prod` only.

## Sequencing and gates

1. **Price against committed code.** The working copy has an uncommitted change that reads `bom_misc.sku_id`, and that column doesn't exist on prod yet. The script therefore runs from a temporary worktree of HEAD.
2. **Snapshot** the 10 rows to the scratchpad.
3. **Dry run**, rolled back. The resolved amounts must equal the table below exactly; any difference aborts.
4. **Commit** in one transaction:
   - lock the rows with `FOR UPDATE`;
   - assert the `mfg_id`, that `po_type` is `normal`, and that all 3 price columns are NULL;
   - the `UPDATE` must hit exactly 1 row;
   - write 3 `history_pos` rows per PO (`changed_by = 2`).
5. **Verify:** the scoped SKUs have 0 unpriced normal POs, and there are 30 new `history_pos` rows.

**Not touched:** qty, status, receipts and already-priced POs. Nothing is re-mailed and nothing goes to Uniware.

## Scope: 10 POs

| Mfg | SKU | Agreed rate | Latest priced PO | PO: qty → pre-GST / total |
|---|---|---|---|---|
| Kain (10) | MCaf278 | **38.48** | **22.39** (MCAFF-PO-202609-039) | MPO-OO113244, MPO-OO113420, MPO-OO113536: 10,000 each → 384,800.00 / 454,064.00 |
| Kain (10) | 25SMCaf194 | 13.04 | 13.462 (MCAFF-PO-202609-046) | MPO-OO113134 36,000 → 469,440.00 / 553,939.20 · MPO-OO113360 4,800 → 62,592.00 / 73,858.56 · MPO-OO113506 17,000 → 221,680.00 / 261,582.40 |
| ADF (3) | MCFMUBX0420F0050 | **100.20** | **58.16** (MCAFF-PO-202610-003) | MPO-OO113092 (cancelled) 13,000 → 1,302,600.00 / 1,537,068.00 |
| ADF (3) | MCFMUBX0419F0050 | 109.57 | 109.57 (MCAFF-PO-202609-082) | MPO-OO113090 13,000 → 1,424,410.00 / 1,680,803.80 |
| ADF (3) | MCFMUBX0354F0050 | **97.93** | **60.80** (MCAFF-PO-202610-001) | MPO-OO113091 (cancelled) 15,000 → 1,468,950.00 / 1,733,361.00 |
| ADF (3) | MCFMUBX0353F0050 | **98.58** | **68.74** (MCAFF-PO-202610-002) | MPO-OO113089 (cancelled) 13,000 → 1,281,540.00 / 1,512,217.20 |

All 10 are costed, with no RM or PM line missing a rate.

## Flags

1. **The agreed rate is far above the latest PO for 4 SKUs:**

   | SKU | Agreed | Latest PO |
   |---|---|---|
   | Kain MCaf278 | 38.48 | 22.39 |
   | ADF MCFMUBX0420F0050 | 100.20 | 58.16 |
   | ADF MCFMUBX0354F0050 | 97.93 | 60.80 |
   | ADF MCFMUBX0353F0050 | 98.58 | 68.74 |

   Each is 40–70% higher. Either the costing or the October POs carry the wrong rate. Under the "agreed costing for all" rule these would fill at the agreed rate.
2. **25SMCaf194:** the agreed rate is 13.04 and the September PO is 13.462. That's a small gap, probably a rate update since.
