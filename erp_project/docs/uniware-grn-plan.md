# Uniware GRNs against inward POs — plan

**Goal.** Show what the warehouse actually *accepted* against each inward PO, not
just what the invoice claimed: GRN count, received quantity, **rejected quantity
and its value**, batch/expiry, per SKU. Then derive good vs bad inventory from it.

Today the chain stops one step short. `invoice_mfg.uniware_po_code` mirrors our
invoice into Uniware and `uniware_status` tells us the PO's state — but nothing
reads the inflow receipts, so `purchase_orders.received_qty` still says what the
*invoice* said, which is a claim, not a receipt.

---

## 0 · The gate — do not write code before this

`check_uniware_apis/po_grn.py` FINDINGS, verbatim:

> `getInflowReceipt` has NEVER run live: nothing in DB_NAME_TEST has a GRN.

and

> Response shapes are per-endpoint and inconsistent. **A wrong key never errors —
> it reads as an empty-but-successful record.**

Those two together are the whole risk. If `rejectedQuantity` is really
`rejectedQty`, we ship a screen that says "0 rejected" for every GRN forever and
nothing anywhere fails. Same for whether `quantity` is gross or net of rejected —
get that backwards and every good/bad number is wrong in a plausible direction.

**Gate 0 (manual, ~30 min, no code):**

1. In the sandbox, receive a partial quantity against a mirrored PO, **rejecting
   a few units**.
2. `python check_uniware_apis/po_grn.py --grn-detail <code>` — it prints every
   key that actually came back rather than a guessed list, precisely for this.
3. Write the answers into the FINDINGS block:
   - the per-item **SKU field name** (`itemSKU`? `itemTypeSKU`? unconfirmed)
   - is `quantity` **net** of `rejectedQuantity`, or gross?
   - is there a per-item **`unitPrice`** on a receipt, or only on PO items?
   - what does the receipt header carry — `statusCode`, `vendorInvoiceNumber`,
     `created`, facility?
   - are receipt codes really bare strings?

Everything below is written against the *expected* shape. **Phase 1 starts only
once Gate 0 has replaced expectation with observation.** If the shape differs,
the plan doesn't change — only the field map in one file does.

> Second open question worth answering in the same sitting, already listed in the
> script: **is putaway visible over the API at all?** A clean "no" is a real
> finding — it decides whether "good inventory" can ever mean *shelved* rather
> than *accepted at the dock*.

---

## 1 · The one rule that governs the whole design

**GRN data is a mirror. It never overwrites our books.**

`received_qty` is written by `lib/po/po-receive.ts` when we commit an invoice —
that is our record of what we were told arrived. Uniware's GRN is the warehouse's
record of what it accepted. **They will disagree, and the disagreement is the
entire product.** If the sync writes GRN quantities into `received_qty`, the
divergence is destroyed on the first sweep and the feature reports nothing.

So: GRNs land in their own tables, and every comparison is derived at read time.

Three corollaries:

- Reconciliation is a **three-way** gap, not two: Ordered (`purchase_orders.qty`)
  → Invoiced (`invoice_items_mfg.qty`) → Accepted + Rejected (GRN). Each gap has
  a different owner — procurement, the manufacturer, the warehouse.
- Nothing in the sync path writes to `purchase_orders` at all.
- A PO with no GRN is not an error. `inflowReceiptsCount = 0` means "nothing
  received yet, however approved the PO looks" — the script says so explicitly.

---

## 2 · Sequencing

| Phase | Delivers | Gate to the next |
|---|---|---|
| **0** | Verified response shape in FINDINGS | Field names observed, not guessed |
| **1** | Schema + sync, no UI | Counts reconcile against `--grn` for 5 real POs |
| **2** | Pure totals/reconciliation helpers + unit tests | Tests green; a deliberately wrong field name fails one |
| **3** | UI — panel first, then columns | Someone at the inwarding desk reads it and agrees |
| **4** | Good/bad inventory view | Definitions signed off (§6) |

Phases 1 and 2 are invisible to users, deliberately. A sync that has run for a
week and whose stored counts match `--grn` by hand is the evidence that the UI in
Phase 3 is worth building.

---

## 3 · Phase 1 — schema and sync

### 3.1 Two new tables

Mirrors of an external system, so read-only to the app and safe to re-derive by
truncating and re-syncing. Naming follows `invoice_mfg` / `invoice_items_mfg`.

```
grn_uniware
  id                  INT PK
  grn_code            VARCHAR(64)  UNIQUE   -- inflowReceiptCode
  uniware_po_code     VARCHAR(64)  INDEX    -- joins to invoice_mfg.uniware_po_code
  invoice_id          INT NULL     INDEX    -- resolved from the above; NULL = orphan GRN
  facility_code       VARCHAR(50)           -- which facility answered
  status_code         VARCHAR(40)
  vendor_invoice_no   VARCHAR(100)          -- the manufacturer's invoice no, per FINDINGS
  grn_created_at      DATETIME NULL         -- epoch millis / 1000; see §5
  total_qty           DECIMAL(12,3)         -- Σ items, stored so the list needs no join
  total_rejected_qty  DECIMAL(12,3)
  synced_at           DATETIME
  raw                 JSON NULL             -- see below

grn_items_uniware
  id              INT PK
  grn_id          INT  INDEX
  line_no         INT
  sku_code        VARCHAR(50)  INDEX
  po_id           INT NULL     INDEX  -- OUR inward PO for this (uniware_po_code, sku)
  quantity        DECIMAL(12,3)
  rejected_qty    DECIMAL(12,3)
  batch_code      VARCHAR(100)
  expiry          VARCHAR(20)
  mfg_date        VARCHAR(20)
  UNIQUE (grn_id, line_no)
```

**On `raw`.** Keep the receipt JSON for the first months. This endpoint has never
run live; the first time it returns a field we didn't map, `raw` is the
difference between a re-sync and a lost month. Drop it once the shape is boring.

**On `po_id`.** This is the join that makes the whole feature work, and it exists
only because of a decision already taken: `mergeInwardLinesBySku`
(`lib/invoice/invoice-merge.ts`) creates **ONE inward PO per SKU**, mirroring
`mergeItemsBySku` so our POs and Uniware's items line up **1:1**. So a GRN item
resolves to exactly one of our POs by `(uniware_po_code, sku_code)`. That comment
in the codebase is load-bearing for this plan — if the merge rule ever changes,
this join breaks.

Resolve `po_id` at sync time, not read time: an unresolvable item is a *finding*
(a SKU the warehouse received that we never raised), and it should be visible as
a NULL to investigate rather than silently dropped by a join.

### 3.2 One cheap column that makes the sweep targeted

```
invoice_mfg.uniware_grn_count  INT NULL   -- inflowReceiptsCount, last seen
```

`getPurchaseOrderDetails` **already returns `inflowReceiptsCount`**, and the
existing status sync already calls it (`fetchPurchaseOrderStatus`). Storing it
costs zero extra API calls and turns the GRN sweep from "walk everything" into
"walk only invoices whose count is > 0 and differs from what we hold".

Do this as a small change to `fetchPurchaseOrderStatus` → return
`{ status, grnCount }`, and to `POST /api/v1/purchase-orders/uniware-status`.

### 3.3 The sync route

`POST /api/v1/purchase-orders/uniware-grn` — **separate from the status sync**,
because the cost profile is different: GRNs are `1 + N` calls per PO
(`getInflowReceipts`, then `getInflowReceipt` per code) against the status sync's
flat 1. Sharing a route would blow `maxDuration` for both.

Reuse, don't reinvent:

- `facilityFor()` from `uniware-status/route.ts` — destination + **PAN**, never
  the full GSTIN. Lift it to `lib/uniware/facility.ts` so both routes share one
  implementation rather than two that can drift.
- The same never-throw-per-row shape: one tenant 500 must not cost the other
  forty-nine answers. Report `{ total, synced, failed, failures, truncated }`.
- The same `!facility && !UNIWARE_SANDBOX` hard failure — asking the wrong
  facility answers "not found", which would be stored as a real "no GRNs".
- `MAX_PER_RUN`, reported when it truncates. Start lower than 150 given `1 + N`.

New client functions in `lib/uniware/grn.ts`:

```ts
fetchInflowReceiptCodes(poCode, facility): Promise<string[]>   // FLAT-ish: inflowReceiptCodes
fetchInflowReceipt(code, facility): Promise<UniwareGrn>        // WRAPPED in "inflowReceipt"
```

The wrapper asymmetry is real and documented — `getPurchaseOrderDetails` is flat,
`getInflowReceipt` is wrapped, in the same namespace. Do not "tidy" them to
match; the script's `_receipts()` carries the same warning.

Endpoints go in `lib/uniware/endpoints.ts` beside the others. **Note the existing
pin**: `tests/unit/nanonets-endpoints.test.ts` exists because a repo-wide
find-replace once rewrote an outbound `/api/v2/` to `/api/v1/v2/`. Add the GRN
paths to an equivalent pin.

---

## 4 · Phase 2 — the pure layer

Per `AGENTS.md`: a unit test may only import **pure** modules, so the logic worth
testing gets extracted. Same reason `lib/po-split.ts` and `lib/invoice/invoice-merge.ts` exist.

`lib/uniware/grn-totals.ts` — no DB, no network:

```ts
/** Per (po_id) roll-up across every GRN line. */
grnTotalsByPo(items): Map<number, { accepted, rejected, grnCount, lastReceivedAt }>

/** The three-way gap for one inward PO. */
reconcile({ orderedQty, invoicedQty, accepted, rejected }): {
  accepted, rejected,
  awaited,        // invoiced - accepted - rejected  (in transit / not yet booked)
  overReceipt,    // accepted + rejected - invoiced  (> 0 = warehouse took more than billed)
  rejectRate,     // rejected / (accepted + rejected)
}

/** Rejected VALUE — see §6 on why the rate comes from our invoice. */
rejectedAmount(rejectedQty, invoiceRate): number
```

Tests in `tests/unit/uniware-grn.test.ts` must include **a fixture with a
misspelled field** asserting it surfaces as a failure, not as a zero. That is the
only defence against the "wrong key reads as empty-but-successful" hazard, and it
is the single most valuable test in this plan.

---

## 5 · Dates — parse per field, never once

Straight from FINDINGS, and it has already bitten once:

> `getPurchaseOrderDetails` returns `created` as a Unix epoch in **MILLISECONDS**
> (1787206929000), not the ISO string the docs publish. […] Date formats are
> MIXED inside one payload: `created` is epoch millis while `deliveryDate` is a
> plain `"2026-08-10"` string.

So the GRN mapper needs an explicit per-field decoder, not a generic date parse.
`expiry` / `mfg_date` stay **VARCHAR** in our schema, exactly as
`invoice_items_mfg.expiry` and `.mfg_date` already do — they are what the
document said, not something we derive.

---

## 6 · Good vs bad inventory

### 6.1 Definitions — these need your sign-off before Phase 4

| Term | Definition | Source |
|---|---|---|
| **Good (accepted)** | Σ `inflowReceiptItems[].quantity` | GRN — *pending Gate 0: is this net of rejected?* |
| **Bad (rejected)** | Σ `rejectedQuantity` | GRN |
| **Awaited** | Invoiced − Accepted − Rejected | derived |
| **Rejected value** | Rejected qty × **our invoice rate** | `invoice_items_mfg.rate` |
| **Reject rate** | Rejected ÷ (Accepted + Rejected) | derived |

**Why rejected value uses our rate, not Uniware's.** `unitPrice` is confirmed on
PO *items*; it is **not** confirmed on receipt items (Gate 0 settles this). Our
invoice rate is the number we will actually raise a debit note against, so it is
the right basis regardless — and it is already reconciled on screen against the
PO rate by the existing `invoice_rate` / `invoice_rate_mixed` columns in
`PoDataRow`. If Gate 0 finds a receipt-level `unitPrice`, show it *beside* ours as
a discrepancy, don't replace ours with it.

### 6.2 What "good inventory" can honestly mean

**Accepted at the dock ≠ available to sell.** Putaway may not be visible over the
API at all (open question, §0). Until that's answered, the honest label is
**"Accepted"**, not "Good inventory" or "In stock" — and the UI should say
Accepted. Naming it "stock" invites someone to reconcile it against Uniware's
actual inventory report, which it will never match.

If putaway turns out to be unavailable, the fallback for true stock is the
existing **export-job** path (`lib/uniware/export-jobs.ts`) rather than a REST
walk — that machinery already exists for the vendor-item master.

### 6.3 Where it's computed

Derived, never stored. A stored `good_qty` is a third copy of a number that
already exists twice and will drift from both. One query
(`grnSql.totalsByPo` / `totalsByMfg`) plus the pure helpers in §4.

---

## 7 · Phase 3 — UI

Existing surfaces first. Three places, in order of value:

**a) `InwardingPanel` — the primary home.** It already answers "does what arrived
add up, and is anything missing a document", with Ordered / Received / Open above
the invoice lines. GRNs belong directly under that reconciliation block:

```
Ordered 5,000   Invoiced 5,000   Accepted 4,850   Rejected 150 (₹5,430)   Awaited 0
                                                  ▲ 3.0% reject rate

GRN-2627-0041   COMPLETE   27 Aug   inv MC/1182   recd 4,850   rej 150
  Mcaf407   B/2608A   exp 03/28    recd 2,400   rej 100
  Mcaf409   B/2608B   exp 03/28    recd 2,450   rej  50
```

Extend the panel's existing reconciliation row rather than adding a second one —
Accepted / Rejected / Awaited sit alongside Ordered / Received / Open.

**b) `PoTable`, inwarding mode only.** Reuse `ProgressCell` — add rejected as a
red segment beside the received bar, so the existing column carries the new fact
instead of the table growing wider. It is already 13+ columns; a new Rejected
column earns its width only if the segment proves unreadable.

**c) `/po-tracking/invoices`.** The row already shows the Uniware code and status.
Add GRN count and rejected total to that same row — `InvoiceGroupTable` is shared
with the inwarding desk's history dialog, so both get it from one change.

**A "Sync GRNs" button** beside the existing Sync Uniware button, reusing
`SyncUniwareButton`'s summary shape (`lib/uniware/errors.ts`'s
`uniwareErrorReasons` + `app/po-tracking/sync-summary.ts` — counts and reasons as
separate lines, already built and tested).

---

## 8 · Access control — not optional

New routes addressed by an id **must** declare scope or the build fails:
`tests/unit/route-scope.test.ts` enforces it on `/api/v1/**/[id]/**`, and it
exists because this exact bug shipped three times (a filtered list beside an
unfiltered by-id sibling).

- GRN data hangs off an invoice → `scope: { type: "invoice", from: … }`, which
  delegates to `assertInvoiceInScope` (mfg + destination + per-line brand).
- The panel's data is per PO → `assertPoInScope`, as the inwarding route already does.
- The sweep route is a bulk action; scope it to what the caller may see, or
  restrict it to an admin-level `access` and say so.

---

## 9 · Risks

| Risk | Mitigation |
|---|---|
| **Wrong field name reads as zero, never errors** | Gate 0 + a misspelled-field unit test that must fail |
| `getInflowReceipt` unproven live | Gate 0 before any code |
| `quantity` gross vs net of rejected | Gate 0. Every total in §6 depends on it |
| `1 + N` calls per PO blows `maxDuration` | `uniware_grn_count` targets the sweep; own `MAX_PER_RUN`; report truncation |
| Sandbox pins facility, so dev proves nothing about prod mapping | Same `!facility && !UNIWARE_SANDBOX` hard failure the status sync uses |
| GRN item resolves to no PO of ours | Store `po_id` NULL and surface it — a real finding, not a dropped row |
| Someone "fixes" `received_qty` from GRN | §1. Call it out in the sync route's header comment |
| Merge rule changes and the 1:1 join breaks | Note the dependency in `invoice-merge.ts` beside the existing comment |

---

## 10 · What I'd cut if this needs to be smaller

Phases 0–2 plus **only** the `InwardingPanel` section (7a). That answers "show
the GRNs done against the inward PO we made, with rejected highlighted" in full.
Table columns (7b), the invoices tab (7c) and the inventory view (Phase 4) are
all additive afterwards and need no rework.

---

## Open questions for you

1. **"Good/bad inventory" — accepted-at-dock, or shelved?** Decides whether this
   ends at GRNs or needs a putaway/stock source too (§6.2).
2. **Rejected value basis** — our invoice rate (my recommendation, §6.1) or
   Uniware's, if Gate 0 finds one?
3. **Sync cadence** — manual button like today's Sync Uniware, or scheduled? The
   existing status sync is deliberately manual ("a NULL timestamp means never
   asked, not no status").
4. **Debit notes** — is rejected quantity meant to feed a credit/debit note
   against the manufacturer later? If yes, `grn_items_uniware` needs to be
   addressable per line from day one; if no, totals suffice.
