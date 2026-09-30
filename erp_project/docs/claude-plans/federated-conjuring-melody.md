# Uniware GRNs against inward POs

## Context

When a supplier invoice is inwarded, `lib/invoice/invoice-inward.ts` raises inward
POs, mirrors them to Unicommerce as one PO per invoice, and stamps
`invoice_mfg.uniware_po_code`. `POST /api/v1/purchase-orders/uniware-status` then
refreshes `uniware_status` for each mirrored PO.

The chain stops one step short of the thing procurement actually needs.
`purchase_orders.received_qty` currently records **what the invoice claimed**, not
what the warehouse accepted — it is written by `lib/po/po-receive.ts` at
invoice-commit time. Nothing reads Uniware's inflow receipts (GRNs), so **rejected
quantity is invisible everywhere in the ERP**.

This adds a read-only GRN mirror so each inward PO shows accepted qty, rejected
qty and its value, per SKU with batch and expiry, reconciled against what was
ordered and invoiced.

**Decisions taken (2026-08-31):** Good/Bad means *accepted at the dock*, from
GRNs only — putaway is out of scope and the UI says "Accepted", never "In stock".
Sync is a manual button now, written as a callable so a scheduler can reuse it.
Rejected quantity is for visibility only — no debit-note workflow, so the GRN
tables are a re-derivable mirror. UI is the inwarding detail panel only.

---

## Gate 0 — verify the API shape before writing any code

`check_uniware_apis/po_grn.py` FINDINGS records two facts that make this a gate
rather than a step:

> `getInflowReceipt` has NEVER run live: nothing in DB_NAME_TEST has a GRN.

> Response shapes are per-endpoint and inconsistent. **A wrong key never errors —
> it reads as an empty-but-successful record.**

If `rejectedQuantity` is actually spelled differently, we ship "0 rejected"
forever and nothing fails. Same if `quantity` is gross rather than net of
rejected — every number in §Good/Bad is then wrong in a plausible direction.

**Do this first, manually, no code:**

1. Sandbox: receive a partial qty against a mirrored PO, **rejecting some units**.
2. `python check_uniware_apis/po_grn.py --grn-detail <code>` — it deliberately
   prints every key that came back rather than a guessed list.
3. Record in the FINDINGS block:
   - per-item **SKU field name** (`itemSKU`? unconfirmed)
   - is `quantity` **net** of `rejectedQuantity`?
   - is there a per-item **`unitPrice`** on a receipt?
   - header fields: `statusCode`, `vendorInvoiceNumber`, `created`
   - are receipt codes bare strings?

If the shape differs from the assumptions below, only the field map in
`lib/uniware/grn.ts` changes — the rest of the plan holds.

---

## The rule that governs the design

**The GRN mirror never writes to `purchase_orders`.**

`received_qty` is our record of what we were told arrived; the GRN is the
warehouse's record of what it accepted. They will disagree, and *the
disagreement is the product*. A sync that writes GRN quantities into
`received_qty` destroys the signal on its first run. Reconciliation is derived at
read time, three-way: Ordered → Invoiced → Accepted + Rejected.

A PO with no GRN is not an error — `inflowReceiptsCount = 0` means nothing has
been received yet, however approved the PO looks.

---

## Phase 1 — schema

**`prisma/add_uniware_grn.sql`** (new; MySQL 8, not re-runnable, run on both
schemas, keep `prisma/schema.prisma` in sync).

```
grn_uniware
  id, grn_code VARCHAR(64) UNIQUE, uniware_po_code VARCHAR(64) INDEX,
  invoice_id INT NULL INDEX, facility_code, status_code,
  vendor_invoice_no, grn_created_at DATETIME NULL,
  total_qty DECIMAL(12,3), total_rejected_qty DECIMAL(12,3),
  synced_at DATETIME, raw JSON NULL

grn_items_uniware
  id, grn_id INT INDEX, line_no INT, sku_code VARCHAR(50) INDEX,
  po_id INT NULL INDEX, quantity DECIMAL(12,3), rejected_qty DECIMAL(12,3),
  batch_code VARCHAR(100), expiry VARCHAR(20), mfg_date VARCHAR(20),
  UNIQUE (grn_id, line_no)
```

Plus one column that makes the sweep cheap:

```
invoice_mfg.uniware_grn_count INT NULL   -- inflowReceiptsCount, last seen
```

- `raw` — keep the receipt JSON for the first months. This endpoint has never run
  live; the first unmapped field makes it the difference between a re-sync and a
  lost month. Drop it once boring.
- `expiry` / `mfg_date` stay **VARCHAR**, matching `invoice_items_mfg` — they are
  what the document said, not something we derive.
- `po_id` is resolved **at sync time**. It works because
  `mergeInwardLinesBySku` (`lib/invoice/invoice-merge.ts`) creates **one inward
  PO per SKU** so our POs and Uniware's items line up 1:1. Add a note there —
  this join depends on that rule. An unresolvable item stores NULL and is
  surfaced, not dropped: it means the warehouse received a SKU we never raised.

---

## Phase 2 — client, pure logic, sync

**`lib/uniware/endpoints.ts`** — add two paths beside the existing ones:
`purchase/inflowReceipt/getInflowReceipts`,
`purchase/inflowReceipt/getInflowReceipt`. Pin them in a unit test the way
`tests/unit/nanonets-endpoints.test.ts` pins Nanonets (a repo-wide find-replace
once rewrote an outbound path and it compiled, linted and 404'd).

**`lib/uniware/grn.ts`** (new) — client + field mapping.
```ts
fetchInflowReceiptCodes(poCode, facility): Promise<string[]>  // { inflowReceiptCodes }
fetchInflowReceipt(code, facility): Promise<UniwareGrn>       // WRAPPED in "inflowReceipt"
```
The wrapper asymmetry is real: `getPurchaseOrderDetails` is flat,
`getInflowReceipt` is wrapped, same namespace. Do not normalise them — `_receipts()`
in `po_grn.py` carries the same warning. Dates are **mixed inside one payload**
(`created` is epoch millis, `deliveryDate` a plain string), so decode per field.

**`lib/uniware/grn-totals.ts`** (new, **pure** — no DB, no network, so a unit test
can import it per `AGENTS.md`):
```ts
grnTotalsByPo(items): Map<number, { accepted, rejected, grnCount, lastReceivedAt }>
reconcile({ orderedQty, invoicedQty, accepted, rejected }):
  { accepted, rejected, awaited, overReceipt, rejectRate }
rejectedAmount(rejectedQty, invoiceRate): number
```

**`lib/uniware/grn-sync.ts`** (new) — the sweep as a **callable**, not inline in a
route, so a scheduler can call it unchanged later. Reuses, rather than repeats:
- `facilityFor()` — **lift it out of** `app/api/v1/purchase-orders/uniware-status/route.ts`
  into `lib/uniware/facility.ts` so both syncs share one implementation. Matches
  on **PAN, never the full GSTIN** (Kreative bills Mumbai and ships everywhere).
- The same `!facility && !UNIWARE_SANDBOX` hard failure — asking the wrong
  facility answers "not found", which would be stored as a real "no GRNs".
- The same never-throw-per-row shape and `{ total, synced, failed, failures, truncated }`
  result as `pushPurchaseOrders`.
- Own `MAX_PER_RUN`, **lower than the status sync's 150**: GRNs are `1 + N` calls
  per PO, not 1.

**Targeting.** `fetchPurchaseOrderStatus` in `lib/uniware/purchase-order.ts`
already calls `getPurchaseOrderDetails`, which **already returns
`inflowReceiptsCount`**. Change it to return `{ status, grnCount }` and have the
status route store `uniware_grn_count`. Zero extra API calls, and the GRN sweep
then walks only invoices whose count is > 0 and differs from what we hold. Its
only caller is the status route, so the signature change is contained.

**`lib/queries/uniware-grn.ts`** (new) — upsert by `grn_code`, replace items by
`grn_id`, `selectByPoId`, `totalsByPo`.

**`app/api/v1/purchase-orders/uniware-grn/route.ts`** (new) — thin wrapper over
`grn-sync.ts`. Bulk action, so gate it at `access: { pageSlug: "/po-tracking", level: "editor" }`
and scope the set it sweeps to what the caller may see.

**Tests — `tests/unit/uniware-grn.test.ts`.** Must include a fixture with a
**deliberately misspelled field** asserting it surfaces as a failure, not a zero.
Given "a wrong key reads as empty-but-successful", this is the single most
valuable test here.

---

## Phase 3 — UI: the inwarding panel only

**`app/api/v1/purchase-orders/[id]/inwarding/route.ts`** — extend the existing
payload with `grns` and the reconciliation totals. It already calls
`assertPoInScope`; keep that. Any new id-addressed route needs `scope:` or
`tests/unit/route-scope.test.ts` fails the build.

**`app/po-tracking/po-procurement/po-types.ts`** — add `GrnLine` / `GrnReceipt`
and extend `InwardingResponse`.

**`app/po-tracking/po-procurement/InwardingPanel.tsx`** — the panel already leads
with Ordered / Received / Open because its job is "does what arrived add up".
**Extend that existing row** rather than adding a second block:

```
Ordered 5,000   Invoiced 5,000   Accepted 4,850   Rejected 150 (₹5,430)   Awaited 0
                                                  ▲ 3.0% reject rate

GRN-2627-0041   COMPLETE   27 Aug   inv MC/1182   recd 4,850   rej 150
  Mcaf407   B/2608A   exp 03/28    recd 2,400   rej 100
  Mcaf409   B/2608B   exp 03/28    recd 2,450   rej  50
```

**Sync GRNs button** — reuse `SyncUniwareButton`'s shape and
`app/po-tracking/sync-summary.ts` (counts and reasons as separate lines, already
built and tested) with `uniwareErrorReasons` from `lib/uniware/errors.ts`.

Not in this cut, additive later with no rework: the rejected segment on
`ProgressCell` in `PoTable` inwarding mode, and GRN totals on the invoices tab
via `InvoiceGroupTable`.

---

## Good vs bad inventory

| Term | Definition | Source |
|---|---|---|
| **Accepted** | Σ `inflowReceiptItems[].quantity` | GRN — *Gate 0: net of rejected?* |
| **Rejected** | Σ `rejectedQuantity` | GRN |
| **Awaited** | Invoiced − Accepted − Rejected | derived |
| **Rejected value** | Rejected × **our invoice rate** (`invoice_items_mfg.rate`) | derived |
| **Reject rate** | Rejected ÷ (Accepted + Rejected) | derived |

All derived, never stored — a stored `good_qty` is a third copy of a number that
already exists twice and will drift from both.

**Rejected value uses our invoice rate** because that is what a debit note would
be raised against, and `unitPrice` is confirmed only on PO items, not receipt
items. If Gate 0 finds a receipt-level `unitPrice`, show it *beside* ours as a
discrepancy rather than replacing ours.

**The label is "Accepted", not "Good inventory" or "In stock".** Accepted at the
dock is not sellable stock, and naming it stock invites a reconciliation against
Uniware's inventory report that it will never match.

---

## Risks

| Risk | Mitigation |
|---|---|
| Wrong field name reads as zero, never errors | Gate 0 + the misspelled-field test |
| `quantity` gross vs net of rejected | Gate 0 — every total depends on it |
| `1 + N` calls per PO blows `maxDuration` | `uniware_grn_count` targets the sweep; own `MAX_PER_RUN`; report truncation |
| Sandbox pins facility, so dev proves nothing about prod mapping | Same `!facility && !UNIWARE_SANDBOX` hard failure as the status sync |
| Someone "fixes" `received_qty` from GRN | State the rule in `grn-sync.ts`'s header comment |
| `mergeInwardLinesBySku` changes and the 1:1 join breaks | Note the dependency in `invoice-merge.ts` |

---

## Verification

**Gate 0** — `--grn-detail` prints real field names; FINDINGS updated.

**Phase 1–2**
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`, `npm test`.
- Run the sync, then for 5 real POs compare stored rows against
  `python check_uniware_apis/po_grn.py --grn <code>` — GRN count, received and
  rejected totals must match exactly.
- Confirm `purchase_orders.received_qty` is **unchanged** before and after a
  sweep (`SELECT id, received_qty` snapshot, diff it).
- Confirm a PO with `inflowReceiptsCount = 0` is skipped, not recorded as failed.
- Check for `grn_items_uniware.po_id IS NULL` rows — each is a real finding.

**Phase 3**
- `npm run build` (won't run while `npm run dev` is up — Next takes one lock).
- Open an inward PO with a partial+rejected GRN: Ordered / Invoiced / Accepted /
  Rejected / Awaited must add up, and rejected value = qty × invoice rate.
- A PO with no GRN shows the existing panel unchanged, no empty section.
- Sync GRNs button reports counts and reasons on separate lines; a single tenant
  error does not lose the other rows' answers.
- Scope: as a user scoped to one manufacturer, another manufacturer's PO id
  returns 403/404 from the inwarding route.
