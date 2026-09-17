# Invoice line loss — what happened, why, and what was done

**Date:** 2026-09-16 · **Scope:** all 52 supplier invoices in `mcaff_prefg_prod`
**Trigger:** `RP/L/26-27/1212` reported as "9 SKUs, only 4 inwarded"
**Status:** root cause fixed · 38,148 of 42,592 units recovered · 4,444 outstanding

---

## What happened

**16 of 52 invoices (31%) were missing line items: 42,592 units, ₹29.1 lakh of
taxable value, invoiced and physically received, with no record in the system.**

The goods arrived. The invoice header was stored at its full printed value. The
lines accounting for 42,592 of those units were never written, and nothing
reported a discrepancy.

| SKU | Units | Taxable value | Invoices |
|---|---|---|---|
| **`Mcaf409_WB`** | **34,188** | **₹24,00,429** | **14** |
| `MCaf199` | 4,444 | ₹3,55,836 | 3 |
| `140MCaf370_WB` | 2,880 | ₹1,14,134 | 1 |
| `Mcaf212_WB` | 1,080 | ₹42,541 | 1 |
| | **42,592** | **₹29,12,941** | **16** |

`Mcaf409_WB` had never been recorded on a single invoice line — zero rows across
all 52 invoices, despite appearing on 14 of them.

---

## Why it happened

Five links. Break any one and this does not occur.

### 1. A purchase order was imported with an invalid status

`MPO-OO113593` — 49,352 units of `Mcaf409_WB`, nothing received — carried
`status = ''`.

`purchase_orders.status` is
`ENUM('draft','raised','punched','short_closed','partially_received','received','cancelled','rejected') NOT NULL`.
The empty string is **not a member of that enum**.

It came in with the original data migration. All **123 `MPO-OO*` purchase orders
were inserted by direct SQL, outside the application** — none has a `create` row
in `history_pos`, and the bulk-upload path would have produced a different number
format (`{brand}-PO-{YYYYMM}-{seq}`) and written history. Of the ~29 POs in the
same 2026-08-27 batch, every sibling landed on `raised`. Only this one did not.

**No application code wrote this value.** There is no code bug behind the origin —
which is precisely why the defence has to sit at the database boundary.

### 2. MySQL accepted it silently

The instance ran without `STRICT_TRANS_TABLES`
(`sql_mode: IGNORE_SPACE,NO_ENGINE_SUBSTITUTION`). Outside strict mode, MySQL
does not reject an invalid ENUM value — it **stores the empty string and carries
on**. No error, no warning surfaced to the caller.

### 3. An invisible PO cannot be received against

`open-for-receive` filters `status IN ('raised','partially_received')`. `''`
matches neither, so the FIFO matcher could not see a PO holding 49,352
available units. Every invoice carrying that SKU found nothing to book against.

### 4. The only way past an unmatched line is to delete it

`reference_po_id` is mandatory on every line (`invoiceInwardSchema`, since
2026-08-07): *"every inward line books against an order the FIFO match picked, so
there is no 'raise an inward PO for goods nobody ordered' path."*

A line with no open PO raises a shortage; shortages block submit; the only
resolution offered is `removeRow`. **The deletion leaves no trace** — no flag, no
audit row, no count. The desk did the only thing available to save the invoice.

### 5. Nothing reconciled the total against the lines — so nobody noticed

**This is why it ran for weeks across 16 invoices rather than being caught on the
first one.**

`invoice_total` is read from the PDF header at parse time and stored as-is. It is
**never derived from, or compared against, the line items**.

`collectProblems` is the sole gate on submit
(`disabled={submitting || problems.length > 0}`). It validates the invoice
number, destination, manufacturer, SKU mapping, quantities, shortages, missing
reference POs and PO overdraw. **It does not compare the line sum to the invoice
total.** That comparison exists — `sumLineItems` is documented as being there
*"to warn about drift"* — and is displayed on screen. It blocks nothing.

So invoice 84 committed asserting ₹19,59,098 while carrying ₹12,06,359 of lines,
27,412 units of a printed 33,540. Both figures sat in the database. Nothing
compared them.

### What was not the cause

**The parser is exonerated.** Every parse writes a `PO_INVOICE_PARSE` event
recording `lineItems`. Across all 16 affected invoices, that count **equals the
PDF's line count exactly**. Every line was read correctly and shown to the desk.
The loss is entirely downstream of parsing.

---

## What was done

| | |
|---|---|
| `MPO-OO113593` → `raised` | the PO became visible to the matcher again |
| Backfilled 16 lines, 38,148 units | FIFO-replayed oldest-first via the real `receivePo`, so tolerance, auto-close and `history_pos` all behaved normally; one inward PO per SKU per invoice |
| **13 of 14 backfilled invoices reconcile to exactly 100.0%** | which is also what confirms the recovered quantities and rates were right |
| `master_rm.inci_name` `VARCHAR(50)` → `VARCHAR(1000)` | had to land first — see below |
| `STRICT_TRANS_TABLES` enabled | on the connection pool in `lib/db.ts` |
| Gift-kit enum repaired | `alter_details_recipe_mtrl_type_sku.sql` applied; 24 + 24 rows restored to `mtrl_type='sku'`, each cross-checked against `sku_variants` first |

`MPO-OO113593` now reads **49,352 ordered · 34,188 received · 15,164 remaining**,
displaying as `partially_received`. Note the column stores `raised`: `po-receive.ts`
never writes `partially_received`, deriving it from `received_qty` at read time so
no stale value is left behind once the PO completes.

### Strict mode needed a fix before it could be turned on

Enabling it directly would have broken RM material saves. `master_rm.inci_name`
was `VARCHAR(50)` — the narrowest free-text column on the table, against `name`
at 200 and `remarks` at 300. **127 of 858 populated rows (15%) were already
truncated mid-word** ("Disodium EDT", "Sodium Cocoyl Iset", "Rubus idaeus (ra").
A realistic 78-character ingredient list was rejected with `ER_DATA_TOO_LONG`.

Widening the column first was the difference between strict mode being a
safeguard and being an outage. **Those 127 truncated values are not recoverable** —
the tails were never stored, and need re-entering from supplier spec sheets.

Verified on prod, all probes rolled back:

| | before | now |
|---|---|---|
| invalid ENUM on `purchase_orders.status` | silently `''` | **rejected** |
| invalid ENUM on `details_recipe.mtrl_type` | silently `''` | **rejected** |
| 78-char INCI name | silently truncated | accepted (column now fits) |

### Ongoing check

`scripts/_check-invoice-reconciliation.ts` (`npm run test:checks -- --db`):
money reconciliation, PO linkage, the one-inward-PO-per-SKU invariant, `amount`
vs `qty × rate`, and a sweep of all 49 enum columns for out-of-enum values —
which went from **49 bad values to 0**.

---

## What remains

**`MCaf199` — 4,444 units, invoices 79, 82, 84, ₹3,55,836.** Not backfilled, and
not a data fix. All three of its POs are fully received (10,556 ordered, 10,556
received), so there is no order to book against: **these goods were shipped
without a purchase order behind them.** Closing it means raising a retroactive PO,
which is procurement's call. Deferred, noted by the team.

**The design flaw is still open.** Deleting a line at review still leaves no
trace, and the invoice total is still never reconciled against its lines. Strict
mode prevents the *specific* corruption that started this; it does not stop a
future unmatched line being silently deleted. **Reconciling the total at write
time is the single highest-value remaining fix** — it would have surfaced all 16
of these on day one.

Also outstanding:
- The 16 backfilled inward POs were written directly to the database and **not
  mirrored to Uniware**, which the normal flow does. Uniware is unaware of 38,148
  units the ERP now records.
- Invoice 69 may carry a wrong SKU (`15sMCaf371_WB_N1` stored against a PDF line
  reading `140MCaf371_WB`). The money reconciles either way; unverified.
- `idx_po_reference_po` is committed in `prisma/` but was never applied to prod.
  Worth auditing which other migrations have drifted.

---

## Method

- **Money reconciliation** — `SUM(amount × (1 + gst_percent/100))` vs
  `invoice_total` across all 52. GST is uniformly 18% on all 142 lines, so the
  grossing is exact.
- **PDF comparison** — all 52 PDFs pulled from S3 and compared line by line,
  reconciled on **SKU totals** rather than row counts: one PDF line may carry
  several batches, and the FIFO matcher legitimately splits one line across
  multiple POs (7,200 → 6,648 + 552).
- **Parse events** — 187 `PO_INVOICE_PARSE` events read from S3 to establish that
  the parser was not at fault.

The two methods independently flagged **the same 16 invoices**, which is what
makes the set trustworthy.
