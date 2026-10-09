# Jainam invoices: quantity and price read swapped

## What's wrong
`lib/invoice/local/jainam.ts` (the SAP Business One layout) reads the item row the wrong way round. The text layer prints:

```
<hsn> <PRICE>Pcs<batch> <expiry> <mrp> <amount><QTY>
3304.99.90 80.00PcsUE260308 08/2028 499 6400.0080.00        80 units @ ₹80
3304.99.90 80.00PcsUE260334 08/2028 499 198400.002480.00    2,480 units @ ₹80
```

The parser takes the first figure as qty and the last as price. qty × rate = amount holds either way, so no gate in `local/index.ts` can see it. The grand-total qty check doesn't fire because Jainam's total row has no `nos|pcs` quantity. The parser's own header comment (`76.00Pcs … 381596.005021.00`) shows the same swap: 5,021 units at ₹76, not 76 at ₹5,021.

Every Jainam invoice with a text layer since `badaabf` (2026-10-01) is affected. 5245 and 5246 were corrected by hand on the review screen. **5179 (id 352) and 5247 (id 382) were committed as parsed.** 5174 was a scan, went to Nanonets, and is correct.

## Damage on prod (2026-10-09)

| Invoice | Booked | Should be | Inward PO | Receipt against | Uniware PO |
|---|---|---|---|---|---|
| 5179 → Gurgaon | 40MCaf272 57.25 @ 2016 | **2,016 @ 57.25** | MPO-INW-202610-138 | MPO-OO113238 (+57.25, should be +2,016) | GM/2627/PO/2611 |
| 5247 → Mumbai | 15MCaf262 80 @ 2560 | **2,560 @ 80** | MPO-INW-202610-166 | MPO-OO113240 (+80, should be +2,560) | HLPL/2627/6064 |
| 5247 → Mumbai | 15MCaf263 76 @ 2500 | **2,500 @ 76** | MPO-INW-202610-167 | MPO-OO113243 (+76, should be +2,500) | HLPL/2627/6064 |

Neither Uniware PO has been GRN'd or status-synced yet.

**Correcting 5247 over-receives two POs.** Each order is for 5,000:
- MPO-OO113240 would reach 3,711 − 80 + 2,560 = **6,191**.
- MPO-OO113243 would reach 2,991 − 76 + 2,500 = **5,415**.

The extra 1,191 and 415 units need another open PO for the same SKU, or an explicit over-receipt. That's a decision for you.

## Status (2026-10-09)
Ajay chose **code only**: the bad records are notified and are being handled outside this work. Step 2 is done: the parser reads the right columns, and a local parse now refuses any row priced above its MRP. Steps 1, 3 and 4 below are not being done here.

## Sequencing and gates
1. **Uniware first, because the clock is running** (owner: Ajay/ops). The warehouse will GRN against GM/2627/PO/2611 and HLPL/2627/6064 at the wrong qty and price. Correct or cancel and re-raise them in Uniware before any GRN. Doing it from code means a payload change, which must be proved on TEST_FACILITY first.
2. **Parser fix.** Swap the two groups in `jainam.ts`. Add a generic local-parse gate: a row whose rate is above its MRP is rejected, so it goes to Nanonets rather than through. Unit-test it with the real 5245, 5247 and 5179 rows. This stops new damage. ⛔ Gate: re-run the local parser on the 5 stored Jainam PDFs; all must match their correct values.
3. **Data repair on prod** (own go-ahead), one transaction per invoice:
   - fix `invoice_items_mfg` qty and rate;
   - fix the inward POs' qty, received_qty, unit_price and total_amount;
   - correct the receipts on the reference POs, with a `history_pos` row;
   - for 5247, apply the over-receipt decision above.
4. **Warehouse mail.** If the inwarding mail went out with the wrong quantities, a correction mail goes to the same recipients.

## Verification
- **Unit:** the new Jainam fixture rows, plus the rate-above-MRP gate.
- **Re-parse:** all 5 stored PDFs come out matching the corrected DB rows.
- **After repair:** for each affected PO, `received_qty` equals the sum of its `invoice_items_mfg` lines.
