# Audit every invoice against its PDF and its inward POs

## Context

Invoice `RP/L/26-27/1212` was reported as "9 SKUs, only 4 inwarded". Investigating
it found the PDF actually carries **6** SKUs, 4 of which inwarded correctly — and
**two lines silently never made it into the system at all**, 6,128 units and
~₹4.5 lakh of goods:

| SKU | Qty | Why it vanished |
|---|---|---|
| `MCaf199` | 3,300 | Every PO for it was already fully received — nothing open to book against. Correct behaviour, no warning. |
| `MCaf409_WB` | 2,828 | PO `MPO-OO113593` had **49,352 outstanding**, but its `status` is `''` — invisible to the FIFO matcher. |

`purchase_orders.status` is `ENUM(...) NOT NULL`, and prod runs **without
`STRICT_TRANS_TABLES`** (`sql_mode: IGNORE_SPACE,NO_ENGINE_SUBSTITUTION`), so an
invalid value is silently coerced to `''` instead of erroring — exactly the
hazard CLAUDE.md documents for ENUM columns.

The loss is silent because `reference_po_id` is mandatory on every line, an
unmatched line blocks submit, and the only way forward is to delete the row.
Nothing records that it existed: invoice 84 stores the full ₹19,59,098 header
while its lines sum to 27,412 of 33,540 units.

**So the question is no longer "what happened to 1212" — it is "how many other
invoices are quietly short?"** This plan answers that and leaves behind a check
that keeps answering it.

## Two deliverables

### A. `scripts/_check-invoice-reconciliation.ts` — the re-runnable check

Follows the existing `_check-*` convention (`npm run test:checks -- --db`).
Read-only; never writes. Per invoice:

1. **Money reconciliation** — `SUM(amount × (1 + gst_percent/100))` vs
   `invoice_total`. A missing line cannot hide from this. Tolerance-based and
   reported, never asserted: freight and other charges sit outside `line_items`,
   so a small gap is normal and a large one is the signal.
2. **Linkage** — every line has both `po_id` and `received_against_po_id`.
3. **The merge invariant** — exactly one inward PO per distinct SKU, matching
   `mergeInwardLinesBySku` (`lib/invoice/invoice-merge.ts`).
4. **Quantity** — each inward PO's qty equals the sum of its SKU's invoice lines.
5. **Attachment** — `attachment_key` present and the object exists.

Schema-wide, run once not per invoice:

6. **Any `purchase_orders.status` outside the enum** — this is the check that
   would have caught `MPO-OO113593`. Generalise it to every ENUM-backed status
   column, since strict mode being off makes this a schema-wide hazard, not a
   PO-specific one.

Reuse rather than rebuild: `lib/queries/supplier-invoices.ts` for the row shapes,
`lib/invoice/invoice-merge.ts` for the merge rule the check asserts against.

### B. One-time line-by-line PDF audit of all 52

The check above catches anything that moves the money. It cannot catch a correct
amount booked against the **wrong SKU**, which is why this pass opens every PDF.

- Fetch all 52 PDFs via `getFileBuffer` (`lib/s3.ts`) into the scratchpad.
- **Fan out across subagents**, each taking a slice of invoices plus that slice's
  DB rows, returning **only discrepancies** in a fixed shape. Reading 52 PDFs
  inline would be ~400k tokens of mostly-identical letterhead; the fan-out keeps
  the signal.
  > This is the one step that needs explicit sign-off: my standing instruction is
  > not to spawn agents unless asked. Approving this plan is that authorisation.
- Per invoice, compare each PDF `Sl.` line against `invoice_items_mfg`:
  SKU code, quantity, rate, amount — in both directions, so a line present in the
  DB but absent from the PDF is caught as well.
- Batch sub-lines are **not** separate lines: PDF line 1 of invoice 1212 carries
  two batches totalling one 7,200 qty. Conversely one PDF line legitimately
  becomes several DB rows when the FIFO matcher splits it across open POs
  (6,648 + 552). Reconcile on **SKU totals**, not row counts — a naive row-count
  comparison would report every split invoice as broken.

**Output:** one table — per invoice, PDF lines vs DB lines, matched, missing,
extra, and any qty/rate delta, with the missing ones costed.

## Known repairs this will feed

Not applied; listed so the audit's output has somewhere to land.

- `MPO-OO113593` (`id=123`) → `status='raised'`, which un-hides 49,352 units and
  lets `MCaf409_WB`'s 2,828 be inwarded. Needs prod go-ahead.
- `MCaf199`'s 3,300 units have no open PO. That is a business decision — raise a
  PO or write it off — not a bug fix.
- Enabling `STRICT_TRANS_TABLES` is the real prevention, but it changes write
  behaviour across every table and deserves its own plan, not a line in this one.

## Verification

1. **Prove the check catches the known case first.** Run it before fixing
   anything: invoice 84 must appear as unreconciled, and `MPO-OO113593` must
   appear in the invalid-status list. A check that passes a known-broken invoice
   is worthless.
2. Confirm it does **not** flag the 50 invoices that are actually fine —
   specifically that FIFO-split lines and multi-batch PDF lines both reconcile.
3. Cross-check the two methods against each other: every invoice the PDF pass
   reports as short must also be flagged by the money check. A PDF-only finding
   means the arithmetic check has a blind spot worth closing.
4. `npm test`, `npx tsc --noEmit --incremental false`, `npm run lint:changed`.

> `scripts/` is gitignored in this repo (`/scripts/*`), so a new file there is
> silently untracked — the same trap that put `tests/run-checks.ts` in `tests/`.
> Confirm with `git check-ignore -v` before assuming the script is committed.

## Out of scope

- Fixing the silent-deletion UX (a deleted line leaves no record anywhere). Real,
  and the reason this went unnoticed, but it is a product change rather than an
  audit.
- The other 16 manufacturers: all 52 invoices today belong to `MFG-014-REV`.
