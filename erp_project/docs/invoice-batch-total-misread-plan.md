# Batch line read as the item's total (RP/L/26-27/1557)

Status: B1 and C built 2026-11-02, uncommitted. Part A on hold.

**Back-test** (read-only, 821 live prod invoices, 1,171 invoice×SKU groups):
- **Flagged 2:**
  - RP/L/26-27/1557 (this case).
  - RP/L/26-27/1216 (Reve, 14 Sep). The PDF prints MCaf199 900 @ 76.99 = ₹69,291, but the ERP holds 656 units, ₹36,812.85. That is a genuine short booking, apparently from the September line-loss class, not a false positive. Reported to Ajay; data untouched.
- No false positives.

**Still to do:**
- Ajay checks on dev: one Nanonets-parsed invoice writes `parse-cache/<month>/<mfg>/<file>__<hash>.json` + `.raw.json`, and a re-parse writes no new raw file.
- Commit and deploy.

**Decisions (Ajay, 2026-11-02)**
- **Part A, the data fix:** on hold. Ajay will say how to correct it.
- **B1:** blocks the save, on the screen and on the server, once the step 3 back-test is clean.
- **Uniware 15,316:** corrected by hand by our side, which was intended. No follow-up.
- **B1b, B2 and the 15Smcaf370 batch split:** not chosen. B1 is in scope.
- **Part C, readable cache names plus a `.raw.json` of every Nanonets reply:** added.

## What happened
- **Invoice:** RP/L/26-27/1557 (Reve), booked 31 Oct. Its Uniware PO is HLPL/2627/6241 at MUM_WAREHOUSE2.
- **The misread:** the local parser refused the PDF (`tally: no line items`), so Nanonets read it. For Mcaf408_WB, Nanonets put the item's printed total (15,316) on the first batch (AMTDW-425, really 3,752) and still emitted the other four batches. Booked total: **26,880 against a printed 15,316, which is +11,564**.
- **Why nothing stopped it:**
  - Only the first batch carries a rate and amount, and 15,316 × 67.79 = 10,38,271.64 matches the printed line amount.
  - The lines-vs-invoice-total check (`invoiceInwardSchema.superRefine`, `lib/validation/purchase-orders.ts:158`) adds up **amounts**. The unpriced batches add quantity but no money, so it passed.
  - Nothing compares quantity against amount.
- **Same invoice, smaller issue:** the 74,000 line of 15Smcaf370_WB_N1 (printed as 35,600 AMSEL-568 plus 38,400 AMSEL-567) was booked as one 74,000 AMSEL-568 line. The quantity is right; the batch split is lost.
- **How widespread:** a scan of every non-reverted prod invoice for "a priced line whose qty × rate = amount, followed by unpriced lines of the same SKU" finds **only this invoice**.

## State on prod now (read 2026-11-02)
| Record | Now | Should be |
|---|---|---|
| `MPO-OO113563` received_qty (ordered 349,700, open) | 129,440 | 117,876 |
| Inward PO `MPO-INW-202610-741` qty | 26,880 | 15,316 |
| `invoice_items_mfg` line 1 of invoice 1027 (AMTDW-425) | 15,316 | 3,752 |
| Uniware HLPL/2627/6241, Mcaf408_WB | 15,316, all pending, no GRN | — already correct |

The ERP sends the merged inward quantity to Uniware (`invoice-inward.ts:450`), which would have been 26,880. So someone appears to have corrected the Uniware PO by hand (see the questions below).

## Part A: correct the data (prod write, separate go-ahead)
**Option A1, revert and re-book (recommended).**
1. Revert invoice 1027 through the INVOICE_REVERT approval. It refuses if Uniware shows a GRN; none exists today.
2. Yogesh re-books from the same PDF with AMTDW-425 = 3,752. He also splits 15Smcaf370 back into its two batches.

What the revert does (review-checked):
- It reverses the full 26,880 on `MPO-OO113563` and marks every inward PO of the invoice `reverted` (`invoice-revert.ts:132-148`).
- It refuses if a payment or verified leg is recorded, or if Uniware can't be reached for the GRN check (`:55-60`, `:92-110`).
- Re-booking the same number is allowed: `live_invoice_no` goes NULL on revert.

What it leaves for us:
- The re-book mints a **second** Uniware PO with the same ReferenceNo. HLPL/2627/6241 is not cancelled, so it must be cancelled in Uniware by hand.
- The re-book re-sends the warehouse mail.

**Option A2, direct correction in one transaction.**
- `MPO-OO113563.received_qty` −11,564, plus a `history_pos` row whose remark names the invoice.
- `MPO-INW-202610-741`: qty and received_qty → 15,316, plus a history row. Read `total_amount` first: it is the sum of the lines' `total_amount`, may be tax-inclusive, and is likely already right.
- Invoice line 1: qty → 3,752.
- Optionally fix the 15Smcaf370 batch split: line 9 → 35,600 AMSEL-568, plus a new line 38,400 AMSEL-567. The new row needs `line_no`, `po_id` (the 15Smcaf370 inward PO `MPO-INW-202610-743`), `received_against_po_id` and `link_type`.
- Uniware is already right, so nothing is sent there.
- Quicker, but it bypasses the approval flow and needs its own audit note.

## Part B: stop it recurring
**B1, a quantity-vs-amount check per SKU on the review screen.**
- **Check:** for each SKU on the invoice, Σ`amount` (pre-tax) ÷ that SKU's `rate` should equal Σqty within the 2% `MATCH_TOLERANCE`.
  - For 1557: ₹10,38,271.64 ÷ 67.79 = 15,316 against 26,880 booked, so it is flagged.
  - On failure: "Mcaf408_WB: lines add up to 26,880 but its amount at ₹67.79 is 15,316 units — check the batches."
- **Why per SKU rather than per run of lines** (review findings 1 and 2):
  - FIFO allocation splits one printed line into several rows, each with a share of the amount.
  - Added rows are appended at the bottom of the list.
  - Per-SKU sums don't care about either: splitting and reordering leave Σqty and Σamount unchanged.
- **Skipped, so a document the check can't read is never blocked:**
  - a SKU with no `rate`, or with differing rates;
  - a SKU with a `discount` (Nanonets' amount is net of discount);
  - a SKU with no pre-tax `amount`. It never falls back to the tax-inclusive `total_amount` (review findings 3 and 4).
- **Pure helper:** `lib/invoice/qty-amount-check.ts`, with unit tests:
  - this invoice;
  - a healthy multi-batch invoice;
  - a FIFO-split invoice;
  - an invoice with an appended row;
  - discount, no-rate and mixed-rate cases.
- **Block or warn** is Ajay's call (see the questions below). Blocking also means a server-side check in `invoiceInwardSchema.superRefine`, using the same helper.

**B1b, a Reve instruction for Nanonets (review finding 10).**
- `lib/nanonets/strategies/index.ts:23` already has an empty `reveStrategy` slot keyed by Reve's GSTIN.
- Fill it with "one object per batch, quantity per batch; never the item total on a batch".
- This addresses the cause. B1 stays as the safety net, because the instruction can be ignored.

**B2, optional auto-correction at parse time.**
- **Rule:** when a priced first batch's qty × rate = its amount AND unpriced same-SKU batches follow, set the first batch to qty − Σ(rest). For this invoice that gives 15,316 − 11,564 = 3,752.
- **Visibility:** the corrected line is flagged in the review screen ("adjusted from 15,316").
- **Risk:** it rewrites a parsed number. Without B1 behind it, a wrong guess would go unnoticed.

**B3, not in scope:** teaching the local parser this Tally layout so Nanonets isn't needed. That is a bigger piece; it can be raised separately.

## Part C: readable cache names and a raw copy of every Nanonets reply (Ajay, 2026-11-02)
**C1, readable cache names.**
- **Today:** `parse-cache/<64-char sha256>.json` (`lib/invoice/parse-cache.ts:9`), which can't be read by a person browsing S3.
- **New:** `parse-cache/<YYYY-MM>/<mfg code | unknown>/<file name, made S3-safe>__<first 12 of sha256>.json`.
  - Example: `parse-cache/2026-10/MFG-014-REV/Sales_RP_L_26-27_1557__4f22f24e9d94.json`.
- **Still derivable on a retry:**
  - the manufacturer comes from `detectFromPdf`, which runs before the cache lookup (`parse/route.ts:74`);
  - the file name comes with the upload;
  - the month is the IST month of the parse.
  - The short hash keeps two different PDFs with the same file name apart.
- **What it costs:**
  - The cache is 24h, so old hash-only files just stop being used. The app user has no `s3:DeleteObject`, so they stay in the bucket.
  - A retry across midnight on the 1st of a month, or a renamed PDF, misses the cache and costs one Nanonets credit.

**C2, `.raw.json` next to each Nanonets reply.**
- **Path:** the same name as C1, ending `.raw.json`. It is written only when Nanonets was actually called, not on a local parse or a cache hit.
- **Contents:**
  - `at`, `filename`, `mfg`, `strategy`, the 12-char hash;
  - `sent_config`: the extraction config sent, i.e. the field list and the instructions incl. any supplier strategy;
  - `response`: Nanonets' extract response **unmodified**, i.e. `record_id`, `result.content` with `_ref` keys and values as written, plus whatever else it returns.
- **Kept permanently as the record.** It is never read back by the app.
- **Code:**
  - `parseInvoice` (`lib/nanonets/client.ts:161`) also returns the raw response and the config it sent.
  - The parse route writes both with `putEvent`, fire-and-forget like the cache today, so a failed write never fails a parse.
- **Size:** a few KB per invoice.
- **Secrets:** `sent_config` holds no API key; the key travels only in the Authorization header. Check this before shipping.

**Not chosen:** running the quantity-vs-amount check at parse time to highlight lines on the review screen. B1 checks on Save only.

## Sequencing and gates
| # | Step | Gate |
|---|---|---|
| 1 | Ajay answers the questions below | — |
| 2 | B1 helper + unit tests | `npm test` |
| 3 | Back-test B1 over every live prod invoice (read-only) | Flags 1557 and nothing else. Any other hit is reviewed before going further |
| 4 | B1 on the review screen (+ server check if blocking), B1b, B2 if chosen | `tsc --incremental false`, `lint:changed`. Re-run `invoice-revert`, `invoice-multiline-receipt` and `invoice-total-reconciliation`, which parse through this schema. Dev: the 1557 PDF is flagged |
| 4b | C1 + C2: key builder in `parse-cache.ts` with a unit test (S3-safe file names, unknown mfg, month boundary); `parseInvoice` returns raw + config; route writes `.raw.json` | `npm test`. Dev: parse one Nanonets invoice twice. The first writes both files under the readable path; the second is a cache hit and writes no new raw file |
| 5 | Part A on prod | Separate go-ahead. **Runs before B1 deploys if A1 is chosen**, so the re-book isn't held to a check it predates. Afterwards: `MPO-OO113563` = 117,876, and ERP Mcaf408_WB = Uniware 15,316 |
| 6 | Commit, prod deploy | Ajay |

## Risks
- **B1 false positives:** a SKU with two different prices on one invoice is skipped, and so is a discounted line. The step 3 back-test over every live invoice is the check, before anyone's save is affected.
- **Plan reviewed 2026-11-02 by a second agent.** Its blockers (FIFO-split rows, rows appended out of order) are designed out by checking per SKU, and its corrections to A1/A2 are folded in.
- **A1 leaves a stray Uniware PO** if the manual cancel is forgotten.
- **A2 bypasses the approval trail** for a received quantity.
