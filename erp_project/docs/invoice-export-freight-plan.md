# Invoice export: pre/post-GST totals, freight, CN/DN

## What changes in the dump
Both sheets of `/po-tracking/invoices` → Export (Invoices, Line Items; the CSV is the Line Items shape).

| Column | Source |
|---|---|
| Invoice Total Pre GST (was "Invoice Total") | Σ line `amount` (goods only, freight excluded) |
| Amount Payable | `invoice_mfg.invoice_total`, the printed total |
| Freight (pre GST) | new `invoice_mfg.freight_amount` |
| Freight (with GST) | `freight_amount + freight_tax` |
| CN/DN | Per line: (agreed FG costing on the invoice date − invoice rate) × qty. Invoices sheet = Σ of its lines. Blank where the SKU has no agreed costing at that manufacturer |

Freight = every parsed invoice charge (freight, packing, insurance…), summed. Today only Kain has any.

**CN/DN costing** reuses `agreedRatesByMfg(mfgId, null, invoiceDate)` (`lib/costing/agreed-rates.ts`), the same as-of costing the invoice drilldown uses. Only the RM/PM rates are as of the invoice date; recipe lines, fill weight and misc costs are today's (nothing older is archived). Both figures are pre-GST. Computed in the export route, cached per (manufacturer, invoice date), so the export is one costing call per distinct pair rather than per line.
Sign as specified: positive = invoiced below the agreed cost; negative = invoiced above it (the case a debit note recovers).

## Sequencing and gates
1. **DDL, dev only** (me). `prisma/add_invoice_freight.sql`:
   `ALTER TABLE invoice_mfg ADD COLUMN freight_amount DECIMAL(14,4) NULL, ADD COLUMN freight_tax DECIMAL(14,4) NULL`; `schema.prisma` synced. ⛔ stop.
2. **Code on dev** (me):
   - Invoice commit (`lib/invoice/invoice-inward.ts`) stores the request's `charges`, which are parsed today and then discarded (`lib/validation/purchase-orders.ts:99`). Tax uses each charge's GST %, falling back to the goods rate (the same rule `sumCharges` already applies).
   - Export SQL + `lib/export-configs.ts` columns.
   - Backfill script: re-read each stored invoice PDF with the local parser (`detectFromPdf` → `parseCharges`) and write freight. Dry run, then `--commit`. Only invoices with `freight_amount IS NULL`, so it is re-runnable.
   - Checks: `tsc --incremental false`, `npm test`, `lint:changed`.
   - ⛔ Your click-through: export on dev, check the Kain rows.
3. **Prod** (⛔ your go-ahead): DDL → backfill → deploy. **DDL must land before the deploy**, because the export selects the new columns and would 500 on prod without them.

## Prod dry run (read-only, 2026-10-30)
- 731 live invoices: 5 with freight (all Kain, each verified against the PDF's HSN/SAC tax summary), 713 without, 13 scanned (no text layer → stay blank).
- The gap method would have been wrong. Five MFG-014-REV invoices have gaps of ₹38k–₹300k with no freight on the PDF.

## Risks
- Scanned invoices (13) and any future layout `parseCharges` misses show blank freight.
- CN/DN on a recipe reformulated since the invoice prices today's materials at that day's rates.
- A partially rated recipe gives an understated agreed cost (the same figure PO pricing uses), which makes CN/DN read low.
- Export time grows with distinct (manufacturer, invoice date) pairs, about 3 queries each. To be measured on the dev export; if it is slow, cache per manufacturer per month.
- A Nanonets-parsed invoice gets charges only from the text-layer `parseCharges` fallback (parse route line 113), same as today's reconciliation.
