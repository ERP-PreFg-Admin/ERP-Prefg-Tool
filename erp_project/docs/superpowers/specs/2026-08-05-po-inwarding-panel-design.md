# PO Inwarding Detail Panel — Design

**Date:** 2026-08-05
**Surface:** FG PO Tracking (`/po-tracking/po-procurement`)
**Status:** approved, not yet implemented

## Problem

FG PO Tracking lists purchase orders with a `received_qty` column, but there is no
way to see *what* made up that number. An order showing 4,200 of 5,000 received
gives no answer to "which invoices, which batches, when, and is anything missing a
document". The information exists — `supplier_invoice_items` links every invoice
line to the order it was received against — but nothing in the UI reads it.

`lib/queries/supplier-invoices.ts` already contains `selectByPoId`, written for
exactly this purpose and wired to nothing:

```sql
WHERE sii.po_id = ? OR sii.received_against_po_id = ?
```

## Goal

Clicking a PO opens a read-only detail panel listing all inwarding recorded
against it, reconciled against the order quantity. Same split-pane treatment as
the Recipe Master detail panel.

Out of scope: editing anything from the panel, and any change to how inwarding is
recorded.

---

## The double-count trap, and the shape it forces

Both receipt paths funnel through `receivePo()` in `lib/po-receive.ts` — the
manual **Receive** dialog and the invoice inwarding flow in
`lib/invoice-inward.ts`. Each writes an **identical** `history_pos` row:
`field_name='received_qty'`, old → new, `changed_by` = the acting user, and
`s3_key` always `null`.

**There is no column that distinguishes a desk receipt from an invoice receipt.**

Consequently, merging `supplier_invoice_items` with `history_pos` receipt rows
would show every invoice-driven receipt **twice**. Correlating them on
`(qty, timestamp proximity)` is a heuristic that mis-pairs whenever two receipts
of the same quantity land on one day — silently, and in the direction that hides a
missing document.

The panel therefore reconciles by **arithmetic, not correlation**:

| Part | Source | Why it is safe |
|---|---|---|
| Header — Ordered / Received / Open | the order row, returned by the API alongside the lines | Authoritative, and independent of what the table has loaded |
| Timeline entries | `selectByPoId` | One row per invoice line: invoice no, date, batch, qty, amount, PDF |
| One derived entry, **only** when `received_qty > Σ(invoice line qty)` | subtraction | Cannot double-count by construction |

The derived entry reads **"Received without an invoice — N units"**. It carries no
date, so it always renders **last**, after the dated invoice lines — never
interleaved.

The header deliberately comes from the API, not from `PoRow`. Reading it from the
loaded row would be one less round trip, but the panel must also render for a PO
that isn't on the current page (see `?inwardFor=` in the error table), and a header
that silently depends on table state would be blank in exactly that case.
`assertPoInScope` already fetches and returns the order row, so this costs nothing
extra.

### Accepted limitation

Manual receipts appear as **one reconciled total, not per-event**. The data cannot
support per-event attribution. Per-event would require a `source` column on
`history_pos`, which would only label rows created after the migration —
historical rows stay ambiguous either way. Deliberately deferred.

The full per-event receipt log already exists behind the row's **History** action
(`PoHistoryDialog`, backed by `selectPoHistoryByPoId`). The panel links to it
rather than duplicating it.

### Consequence: the panel is never empty

Every state has content, because the header reconciliation always renders:

| State | Shows |
|---|---|
| Invoice lines present | Header + timeline |
| `received_qty > 0`, no invoice lines | Header + the derived "without an invoice" row only |
| Nothing received | Header + "Nothing inwarded yet" |

---

## Trigger

The row already carries a bulk-select checkbox and an action menu, so making the
whole row clickable would fight selection. Two entry points instead:

1. **The PO number cell** (`PoTable.tsx:195`) — the row's identity, already the
   leftmost content cell.
2. **An "Inwarding" item in `PoActionMenu`** — for discoverability, pushed
   alongside the existing "History" entry using the established `MenuAction`
   shape.

Selection is URL-synced as `?inwardFor=<poId>`, mirroring Recipe Master's
`?bomId=`, so the panel survives a refresh and can be linked to.

## Layout

Copies `BOMMasterComponent.tsx`'s split-pane verbatim:

- table container → `w-[58%] shrink-0` when the panel is open, `w-full` otherwise
- panel container → `flex-1 sticky top-6`, collapsing to `w-0 opacity-0` when closed
- `transition-all duration-300 ease-in-out` on both
- panel capped with `max-h-[calc(100vh-3rem)] flex flex-col` so a long invoice list
  scrolls internally rather than overflowing the page

PO Tracking's table is 7 columns, so it tolerates the same 58% squeeze the BOM
table does.

## Panel content

```
┌─ Inwarding ─────────────────────────── ✕ ─┐
│ PO-FG-2026-0184        [Partially Received]│
│ MFG-014 · Acme Foods                       │
│                                            │
│ Ordered 5,000  ·  Received 4,200  ·  Open 800
│ ──────────────────────────────────────────  │
│ INV-8871          12 Jul          2,000  📎 │
│ batch B-22 · exp 03/27 · ₹1,84,000          │
│ ──────────────────────────────────────────  │
│ Received without an invoice      2,200      │
│ no document on file                         │
│ ──────────────────────────────────────────  │
│ Full receipt log →   (opens PoHistoryDialog)│
└────────────────────────────────────────────┘
```

Visual language follows `BomDetailPanel.tsx`: `Card` shell, `StatusBadge` /
`STATUS_CONFIG` for the order status, mono for codes, `Badge` for `link_type`.
The 📎 opens the invoice PDF through `/api/files/presign?key=…&view=1`, the same
call `BomDetailPanel`'s `viewArtifact` makes.

---

## Files

| File | Change |
|---|---|
| `app/api/purchase-orders/[id]/inwarding/route.ts` | **new.** `withGateway` with `paramsSchema`, `access: { pageSlug: "/po-tracking", level: "viewer" }`, then `assertPoInScope(userId, poId)` before the query. |
| `app/po-tracking/po-procurement/InwardingPanel.tsx` | **new.** Read-only presentational panel. Props only — no fetching. |
| `app/po-tracking/po-procurement/useInwardingPanel.ts` | **new.** URL sync + fetch + in-memory cache keyed by `poId`. The fetch half of `useBomDetailPanel`, without edit mode. |
| `PoProcurementClient.tsx` | Wrap the table in the split-pane; mount `InwardingPanel`. |
| `PoTable.tsx` | PO-number cell click; one `MenuAction` push. |
| `po-types.ts` | Add `InwardingLine` and `InwardingResponse` types. |
| `lib/queries/supplier-invoices.ts` | Extend `selectByPoId` — see below. |

### `selectByPoId` extension

The existing query returns enough to list lines but not enough to render them.
Add: `si.invoice_date`, `si.attachment_key`, `si.created_at`,
`si.uniware_po_code`, `u.name AS created_by_name`, and `sii.batch`, `sii.expiry`,
`sii.rate`. Keep the existing `po_id = ? OR received_against_po_id = ?` predicate
and both bind parameters. Order by `si.invoice_date DESC, sii.line_no`.

`mfg_code` / `mfg_name` are **not** added here — they belong to the order, not the
invoice line, and come from the order row `assertPoInScope` returns. Adding them to
every line would repeat the same value on each row for no reason.

### API response shape

```ts
{
  po: { id, po_no, status, qty, received_qty, mfg_code, mfg_name },
  lines: InwardingLine[],          // invoice-linked, newest invoice first
  withoutInvoice: number,          // max(0, received_qty − Σ line qty); 0 renders nothing
}
```

`withoutInvoice` is computed **server-side**, so the subtraction rule lives in one
place rather than being re-derived by any future consumer.

### Security

`assertPoInScope` is **mandatory**, not optional. PO ids are sequential integers;
`lib/po-guard.ts`'s header states the exact hole this closes — without it a user
scoped to manufacturer 1 can read manufacturer 7's inwarding by guessing an id.
Every existing `/api/purchase-orders/[id]/**` route calls it.

## Error handling

| Case | Behaviour |
|---|---|
| PO id not a number | `400` from `paramsSchema` |
| PO does not exist | `404` from `assertPoInScope` |
| PO outside the user's scope | `403` from `assertPoInScope`; panel shows "You don't have access to this order." |
| Query fails | `500` via `withGateway`; panel shows an inline retry. The table is untouched. |
| `?inwardFor=` names a PO not on the current page | Panel fetches it anyway and renders; the API is the authority, not the loaded rows. |

## Verification

No test framework exists in this repo, so verification is manual against real data.

1. `npm run lint && npm run build` — both clean.
2. Pick a PO with invoice-linked inwarding (join `supplier_invoice_items` on
   `received_against_po_id`). Confirm the timeline lines match the invoice, and the
   header's Ordered/Received/Open matches the table row.
3. Pick a PO received **only** through the manual Receive dialog. Confirm exactly
   one "Received without an invoice" row, quantity equal to `received_qty`, and
   **no duplicate** entries — this is the trap the design exists to avoid.
4. Pick a PO with both. Confirm `Σ(invoice qty) + derived = received_qty` exactly.
5. Pick a PO with nothing received. Confirm "Nothing inwarded yet".
6. Signed in as a user scoped to one manufacturer, request
   `/api/purchase-orders/<other mfg's po id>/inwarding` directly. Must be `403`.
7. Open a panel, copy the URL, reload. Same panel opens.
8. Confirm the invoice 📎 opens the correct PDF, and that the bulk-select
   checkbox still works on a row whose PO number was just clicked.
