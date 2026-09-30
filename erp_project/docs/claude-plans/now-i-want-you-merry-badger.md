# Three-way match (PO · POD · INV) on the Invoices tab

## Context

Finance reconciles supplier invoices by hand today and has nothing that says, at a
glance, whether an invoice is safe to pay. The Invoices tab shows what was *billed*
and what the warehouse *accepted*, but never what was *ordered* — so the third claim
in the reconciliation is missing from the screen entirely.

Two facts drive the design:

- **`lib/uniware/grn-totals.ts` already declares the three-way and implements two
  legs.** `reconcile()` takes `orderedQty` in its input type and the body never reads
  it. The PO leg is stubbed out, not absent.
- **`docs/invoice-line-loss-audit-2026-09.md`** found 16 of 52 prod invoices missing
  ₹29.1 lakh of lines, and named the unfixed cause: `invoice_total` is never compared
  against Σ lines. That comparison becomes the INV leg here, so the hole is *visible*
  even before anything blocks on it.

Design: the two screenshots (row-level chip group + "Three-way match" modal), applied
to existing FG invoice data per the decision to skip RM/PM. Vendor → Manufacturer,
Material → SKU.

**Read-only. No writes, no new routes, no schema change.**

---

## The three legs, against real columns

| Leg | Claim | Source |
|---|---|---|
| **PO** | what we ordered | `purchase_orders.qty` of the parent POs, via `invoice_items_mfg.received_against_po_id` |
| **POD** | what the site accepted | `grn_items_uniware.quantity` + `.rejected_qty` (already on the row) |
| **INV** | what we were billed | `Σ invoice_items_mfg.amount × (1+gst%)` vs `invoice_mfg.invoice_total` |

Chip states, matching the mock's legend (green present · grey missing · amber variance):

| Chip | grey | amber | green |
|---|---|---|---|
| PO | any line has no `received_against_po_id` | billed ≠ ordered past tolerance | every line settled a PO, within tolerance |
| POD | `grn_count = 0` | accepted+rejected ≠ billed past tolerance, **or** any rejection | reconciles, nothing rejected |
| INV | invoice has no lines | Σ lines ≠ `invoice_total` past tolerance | reconciles |

Match badge, reusing the mock's wording where it fits:

- **Fully matched** — 3/3 green
- **Variance** — all three on file, ≥1 amber (the mock's "Blocked" row)
- **Invoice matched** — PO + INV green, POD grey → *"POD not on file — match cannot advance."*
- **Unmatched** — PO grey

**Tolerance: 2%**, as the mock's header states, one exported constant. Note it diverges
from `poTolerance()` (10%, capped at 100) in `lib/po/po-rules.ts` — that one governs
auto-closing a PO, a different question, and merging them would change receiving
behaviour. Both named in the constant's comment.

---

## Files

**`lib/invoice/three-way.ts`** — new, **pure** (no `lib/db`, no network) so
`tests/unit` can import it, per AGENTS.md. Exports `MATCH_TOLERANCE`, a
`ThreeWayMatch` type and `threeWayMatch(row)` returning
`{ po, pod, inv, matched, badge, reason }`. Calls the existing `reconcile()` in
`lib/uniware/grn-totals.ts` rather than re-deriving the POD gap — **and passes
`orderedQty`, which means wiring up the leg `reconcile()` already declares.**

**`lib/queries/supplier-invoices.ts`** — `INVOICE_LIST_BODY` gains four fields.
Two are plain aggregates, safe beside the existing `COUNT(sii.id)` because they read
the same joined rows at the same grain (`billed_qty` is the precedent):

```sql
COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent,0)/100)), 0) AS lines_value,
SUM(sii.received_against_po_id IS NULL)                              AS po_unlinked_lines,
```

Two must be **scalar subqueries** — the file's own comment explains why a second join
would inflate `item_count` and `received_count`:

```sql
(SELECT COALESCE(SUM(po.qty),0) FROM purchase_orders po
  WHERE po.id IN (SELECT x.received_against_po_id FROM invoice_items_mfg x
                   WHERE x.invoice_id = si.id
                     AND x.received_against_po_id IS NOT NULL)) AS ordered_qty,
(SELECT COUNT(DISTINCT x.received_against_po_id) FROM invoice_items_mfg x
  WHERE x.invoice_id = si.id) AS po_count
```

> ⚠️ **Caveat to write into the comment:** one parent PO settled by two invoices
> reports its *full* ordered qty on both. There is no stored per-invoice share. That
> is why the PO chip is a health signal and the per-PO numbers live in the modal —
> do not present `ordered_qty` as "ordered for this invoice".

**`types/invoice.ts`** — four optional fields on `InvoiceHistoryHeader`, beside the
existing `grn_*` block and documented the same way.

**`app/po-tracking/invoices/InvoiceGroupTable.tsx`** — replace the `Accepted / Rejected`
and `Short Qty` columns with `3-way (PO·POD·INV)` + `Match`; both figures survive inside
the chips and the modal. `GrnCell` and `InvoiceShortCell` fold into the new cells.

> ⚠️ This file is **shared with PO Inwarding's Invoice History dialog** and is already
> modified in the working tree (an added `Inward PO` column). Rebase on that, don't
> revert it.

**`app/po-tracking/invoices/ThreeWayDialog.tsx`** — new. The modal: three cards
(Purchase order · Proof of delivery · Supplier invoice), each with doc ref, qty, value
and a ✓/✗, plus the blue "n document(s) still outstanding" banner. **No new API** —
`GET /api/v1/purchase-orders/invoice/[id]` already returns `{ invoice, items, grns,
documents }`, and already carries `scope: { type: "invoice" }`.

**`app/po-tracking/invoices/InvoicesClient.tsx`** — the summary line
(`N invoices · n on variance · tolerance 2%`) and a Match filter.

**`tests/unit/three-way.test.ts`** — the one runnable check. Pins each badge, both
tolerance edges, and the three states the existing `GrnCell` comment is careful about:
never-synced vs synced-nothing-received vs received.

---

## Sequencing

1. `lib/invoice/three-way.ts` + its unit test — pure, no DB, gates everything else.
2. SQL + types — verify the four new fields against prod read-only before any UI.
3. Table columns (chips + Match cell).
4. Modal.
5. Summary line + Match filter.

Stop after 3 if the numbers look wrong; the chips are the part finance reads.

---

## Deliberately not in this build

- **Payment · Due · Mark paid columns.** No payment state exists anywhere — no column,
  no table, and `app/finance/` doesn't exist. Adding them means deciding whether the
  ERP or Tally owns AP (`docs/module-boundaries-and-tally-plan.md` Track C, not started).
- **Debit notes.** Needs the rejected-value figure to become a document with a number
  and an approval. `rejectedAmount()` in `grn-totals.ts` already computes the amount.
- **Blocking invoice submit on the money leg.** The audit's highest-value fix, but it
  changes what the inwarding desk can do; this screen makes the same breach visible
  first, which is the safer order.
- **A Material column.** An invoice is multi-SKU here; the expansion already lists them.

---

## Verification

```bash
npm test                                  # three-way.test.ts green
npx tsc --noEmit --incremental false      # not plain tsc — stale tsbuildinfo lies
npm run lint:changed
npm run build                             # stop `npm run dev` first; Next 16 locks .next
npm run test:checks -- --db               # _check-invoice-reconciliation.ts still clean
```

End to end, on `/po-tracking/invoices`:

1. The 16 invoices named in the audit doc must show an **amber INV chip** — they are
   the known-short set, and a green chip there means the money leg is wrong.
2. An invoice with no GRN synced shows POD **grey**, not green-zero — "never asked"
   and "received nothing" are different states and this is where they get confused.
3. Open the modal on an invoice with a rejection; accepted/rejected must equal the
   GRN sub-table already rendered in the expansion.
4. Confirm the PO chip is grey on an invoice carrying a line with no
   `received_against_po_id` — the legacy rows the 2026-08 backfill left NULL.
5. Same table inside PO Inwarding → Invoice History renders without breaking.
