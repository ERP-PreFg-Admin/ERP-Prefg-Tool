# NPD Purchase Orders

## Context

New products are ordered ~3 months ahead, before their recipe exists and before
any cost is agreed. Today that PO cannot be raised at all: `poCreateSchema`
demands a positive `recipe_id`, the API rejects a non-`active` SKU, the SKU
picker `INNER JOIN`s `master_recipe_mfg` so an NPD SKU never appears, and the
rate is computed from Agreed Final Costing and is a read-only field in both
dialogs.

Decisions taken with Ajay before writing this:

| | |
|---|---|
| Entry path | **CSV bulk upload on the existing FG PO page.** No new page, no new dialog, no new permission slug. |
| How NPD is recognised | The CSV's existing **`remarks` column** — NPD files always say something containing "NPD". |
| Price | **Zero.** No rate on an NPD PO at all; the supplier invoice carries the truth later. The PO is **never re-rated**. |
| SKU | The CSV always carries a SKU code. If it exists in `master_skus`, use it. If not, **insert it, marked NPD** so it stands as a visible to-do: recipe and costs still owed. |
| Approval | Yes — the CSV path already stages a `PO_BULK` approval, so this is satisfied for free. |
| Uniware | Nothing to do. Procurement POs are never pushed; only inward POs at invoice time. |

## The decision

**NPD is a fourth `po_type`, not a status and not a new column** — mirroring
exactly how `inward` was added (`prisma/add_inward_po_type.sql`, and the
reasoning in `docs/superpowers/specs/2026-08-03-invoice-inwarding-design.md`).
One enum value buys filtering, badging, reporting and the PDF branch.

`remarks` is parsed **once, at ingest**, and the verdict is stored as
`po_type = 'npd'`. Nothing downstream ever does `LIKE '%NPD%'` — remarks is
free text and must not become a query predicate.

**"Zero price" is stored as `unit_price = NULL`, not `0`.** Three reasons, and
the third is the one that matters:

1. `insertBulkPo` already writes no price columns, so NULL is what the path
   does today — the price needs *no code at all*.
2. The PDF and mail layers already collapse `0` into nothing anyway:
   `po-document.tsx:264` is `d.unit_price ? … : "—"` and `mailer.ts:212` is
   `po.unit_price ? Number(…) : null`. Both are falsy checks, so a stored `0`
   and a NULL are indistinguishable by the time they reach paper.
3. **A stored `0` is dangerous where NULL is safe.** `three-way.ts:341` guards
   the unpriced case on NULL; a literal `0` slips past that guard and values
   received goods at ₹0 rather than flagging them unpriced. Same shape in
   `supplier-invoices.ts:171` (`SUM(rejected_qty * unit_price)`). NULL means
   "no price"; `0` asserts "free", and the codebase already believes the
   difference.

## What already works — do not touch

Worth stating, because it's most of the problem:

- **`expected_on` has no upper bound.** Only backdating is forbidden
  (`lib/validation/purchase-orders.ts:36-43`). A 3-month-ahead date is already legal.
- **`recipe_id` already degrades to NULL.** `RECIPE_ID_FOR_LINE`
  (`lib/queries/purchase-orders.ts:102-114`) is a scalar subquery that resolves
  to NULL with no live line, and *every* join from `purchase_orders` to
  `master_recipe` is LEFT — the row is never dropped.
- **`sku_code`, `unit_price`, `total_amount`, `recipe_id` are all nullable already.**
- **The bulk path writes no price and no `recipe_id`** — so an unpriced,
  recipe-less PO is already exactly what this path produces. Zero price needs
  nothing built.
- **The bulk path already skips the `status = 'active'` SKU gate** — it only
  checks `if (!sku)` (`lib/approvals/handlers/purchase-orders.ts:110`). So a
  `new launch` SKU needs no gate change on this path.
- **`master_skus_status` already has `new launch`** (`prisma/schema.prisma:1271-1279`,
  stored as the literal `"new launch"`). Nothing reads it. It is the correct
  status for a stub — no migration needed.
- **`sku_type` is free-text `varchar`, not an enum**, and its dropdown is built
  from `SELECT DISTINCT sku_type` (`lib/queries/skus.ts:256-258`, cached in
  `lib/cached-reference-data.ts:87`). So `'NPD'` needs **no migration and no UI
  code** — it appears in the SKU Master filter the moment the first stub exists.
- **Brand scope survives an unknown code.** `assertSkuCodesInBrandScope`
  (`lib/brand-guard.ts:110-111`) iterates only rows it found, so a brand-new
  `sku_code` passes. See step 4 for the check that has to replace it.
- **`overviewByMfg.open_value` needs no change.** `SUM(COALESCE(total_amount, 0))`
  (`lib/queries/manufacturing.ts:139`) — an unpriced NPD PO contributes 0, which
  is honest, and is already what every bulk-created PO does today. This was a
  required fix while the rate was ₹50; at zero price it disappears.

## Changes

### 1. Migration — `prisma/add_npd_po_type.sql`

Copy the header convention from `prisma/add_inward_po_type.sql` (WHAT / WHY /
SAFETY / RE-RUNNABLE / STATE AS OF, surveyed per schema / Verify with).

```sql
ALTER TABLE purchase_orders
  MODIFY COLUMN po_type ENUM('normal','impromptu','inward','npd') DEFAULT 'impromptu';
```

Append at the end so no existing ordinal moves. Keep
`prisma/schema.prisma`'s `purchase_orders_type` enum in sync. **Dev only** until
Ajay gives a separate go-ahead for prod.

### 2. Detection — `lib/po/po-rules.ts`

This file is already the home of pure PO predicates (`isDraftPo`, `poTolerance`)
and is unit-testable. One addition:

```ts
/** NPD is declared in the uploader's own remarks text, not a dedicated column.
 *  Not \bNPD\b: "_" is a word char, so NPD_TRIAL would miss. */
export function isNpdRemark(remarks: string | null | undefined): boolean {
  return /(^|[^a-z0-9])npd([^a-z0-9]|$)/i.test(remarks ?? "")
}
```

No rate constant — there is no rate.

### 3. CSV columns — `app/po-tracking/po-procurement/po-bulk-fields.ts`

Two fields promoted from "export-only, ignored on import" to declared optional.
Both exist only to build the SKU stub in step 5:

| Field | Why |
|---|---|
| `brand` | Explicit brand for a **new** SKU stub. Not derived — `skuCode.split("-")[0]` is a guess and silently wrong. |
| `sku_name` | The stub's `name`. Already an export column, so a downloaded file already carries it. |

`unit_price` stays ignored on import, exactly as the block comment at `:13-15`
already says. Nothing to change there.

### 4. Brand scope for new SKUs — `app/api/v1/purchase-orders/route.ts`

In the bulk branch, beside the existing `assertSkuCodesInBrandScope` call
(`:63-66`). It must be **here, at upload**, not in the handler — the comment at
`:61-62` explains why: the handler runs as the approver and the approvals queue
is deliberately not brand-scoped, so upload is the only point the uploader's own
grant is knowable.

For every row that is NPD (`isNpdRemark`) **and** carries a `brand` cell,
resolve the brand and `assertInScope(scope, "brand", brandId)`. Reject the whole
upload on a violation, as the existing call does.

### 5. Bulk handler — `lib/approvals/handlers/purchase-orders.ts`

All inside the existing create path (`:96-131`):

- `const isNpd = isNpdRemark(remarks)` — read `remarks` up before the SKU lookup
  (it's currently read at `:114`, after).
- **SKU upsert, marked NPD.** Replace the `if (!sku) { skipped++ }` bail at
  `:110`: if `!sku` **and** `isNpd`, insert a stub, then carry on with the brand
  just written. A non-NPD row with an unknown SKU still skips, unchanged.

  The existing `skusSql.insertSku` writes 6 columns
  (`sku_code, name, brand, category, status, created_by`) and has no `sku_type`
  slot, so it needs one added — that is the only query change here.

  | Column | Value | Why |
  |---|---|---|
  | `sku_code` | the CSV cell | as given, unchanged |
  | `name` | `row.sku_name \|\| skuCode` | `sku_name` is already an export column |
  | `brand` | the CSV `brand` cell | explicit, never guessed from the code prefix |
  | **`sku_type`** | **`'NPD'`** | **the mark.** Free text, so no migration; shows in the SKU Type column and becomes a filter value automatically |
  | `status` | `'new launch'` | already in the enum. Keeps the stub out of the normal Add PO dialog, which demands `active` |
  | `created_by` | `approverId` | |

  Together these make the to-do list answerable with no new screen: SKU Master,
  filter SKU Type = NPD, and the Recipe column already renders `—` for anything
  with no recipe (`app/masters/skus/SkusClient.tsx:79`). Setting `sku_type` also
  silences the spurious "SKU Type" missing-field warning a bare stub would raise
  (`SkusClient.tsx:51`).
- **PO number.** `${brand}-${isNpd ? "NPD" : "PO"}-${yyyymm}-${seq}` — same shape
  as the `IMP` tag at `app/api/v1/purchase-orders/route.ts:131`.
- Pass `isNpd ? "npd" : "normal"` as the new `po_type` param.

**No price logic.** `insertBulkPo` writes no `unit_price` and no `total_amount`
today, and that is precisely the wanted behaviour.

### 6. `insertBulkPo` — `lib/queries/purchase-orders.ts:725`

One change: `po_type` becomes a parameter instead of the hardcoded `'normal'`.
Keep `recipe_id` last — the docstring at `:398-404` explains that its two
resolver params must stay at the tail of the array or a miscount shifts every
value silently.

### 7. PDF — say why the prices are blank

At zero price every money cell already renders `—` (`po-document.tsx:264, 265,
289, 318, 328`), so there is no fabricated number on the document. Two residual
problems worth one small branch:

- `:326` prints the GST label **"18%"** unconditionally, even when every money
  cell beside it is `—`.
- `:366-369` prints *"We declare that this purchase order the actual price of
  the goods described and that all particulars are true and correct"* over a
  document that states no price at all.

So, when `po_type === 'npd'`: suppress the GST percentage label and replace the
declaration with a line saying pricing is to be confirmed and the invoice
governs. Exact wording is Ajay's call.

This needs `po_type` on the row: `purchaseOrdersSql.selectForEmail`
(`:955-995`) does not select it — add it there and to `PoEmailRow` in
`lib/pdf/po-letterhead.ts:23-67`.

`lib/mail/mailer.ts:110-125` freezes the PDF bytes into S3 on first send, so
this has to be right before the first NPD PO is mailed — it is not correctable
afterwards.

### 8. UI — read-only, three small edits

- `po-types.ts:73` — add `"npd"` to the `po_type` union.
- `PoDataRow.tsx:166` — an `NPD` badge, cloning the inline `IMP` badge one line above.
- The `poType` URL param and its server plumbing already exist
  (`buildFilterParams`, `EXCLUDE_INWARD`); `npd` just needs offering wherever
  `impromptu`/`inward` are.

No new tab, no new page, no `lib/pages.ts` entry, no `page_permissions` row.

## Deliberately not doing

- **The Add PO / Impromptu dialogs.** CSV is the stated route. Making the dialogs
  NPD-capable means a second SKU picker that isn't recipe-rooted and relaxing
  `poCreateSchema.recipe_id` — roughly triple the diff. Add it when someone
  actually needs to raise a one-off NPD PO by hand.
- **Re-rating an NPD PO when costing lands.** Explicitly chosen against: the
  invoice carries the truth.
- **A `three-way.ts` PO-rate-vs-invoice-rate variance check.** None exists today
  (`poLeg` is presence-only, `:401-417`), and adding one is its own piece of work.
  An NPD PO has no rate to compare, so it is not this change's problem.

## Verification

```
npm test                                  # isNpdRemark truth table
npm run test:db                           # the bulk-handler test below
npm run lint:changed
npx tsc --noEmit --incremental false      # plain tsc can pass on a file next build rejects
npm run build                             # stop `npm run dev` first — Next 16 locks .next
```

**`tests/unit/po-rules.test.ts`** — extend with `isNpdRemark`: true for `"NPD"`,
`"npd trial batch"`, `"NPD-Q3"`, `"For NPD launch"`, `"NPD_TRIAL"`; false for
`""`, `null`, `"expanded"`, `"unpdated"`.

**`tests/db/po-bulk-npd.test.ts`** (new) — `poBulkHandler.applyAndArchive` takes
an already-open `PoolConnection` and opens no transaction of its own, so it is
testable under `withRollback()` (unlike a route handler — `CLAUDE.md` Testing §3).
Assert, for a two-row NPD file (one known SKU, one new code):
`po_type = 'npd'`, **`unit_price IS NULL` and `total_amount IS NULL`**,
`po_no` matching `-NPD-`, `recipe_id IS NULL`, and a `master_skus` stub carrying
`sku_type = 'NPD'`, `status = 'new launch'` and the brand from the CSV. Also
assert the known-SKU row was **not** re-marked — an existing SKU keeps its own
`sku_type`.

**Manual, end to end:** upload a CSV on `/po-tracking/po-procurement` with
`remarks = "NPD trial batch"`, a known SKU and a new code, `expected_on` ~3 months
out → approve the `PO_BULK` approval → confirm two POs with the NPD badge, no
rate, and the PO Type filter selecting them; then SKU Master → filter **SKU Type
= NPD** lists the new stub with `—` in its Recipe column; then the preview PDF
shows blank prices with the to-be-confirmed wording and no stray "18%".

## Risks

1. **`remarks` is a human-typed trigger.** A file that means NPD but doesn't say
   "NPD" creates ordinary POs — which, since the bulk path is priceless anyway,
   differ only by badge and PO number. Low blast radius, but the CSV preview
   should show the resolved PO type per row so the uploader sees the verdict
   before approving.
2. **Uniware vendor items.** `lib/mfg-facility-push.ts:130-140` refuses to push a
   vendor item for a SKU with no agreed costing. Harmless while the PO is open,
   but the invoice-time inward PO needs that vendor item to exist — so the recipe
   and rates must land before the first NPD delivery is invoiced. This is the
   real deadline the NPD to-do list is counting down to.
3. **Nothing clears the NPD mark.** Once the recipe and costs land, someone must
   edit `sku_type` off `'NPD'` in SKU Master — that edit goes through the normal
   SKU approval flow. Auto-clearing it on first recipe activation is a fair
   follow-up, deliberately not built now: the mark is a human to-do list, and a
   list that empties itself silently is worse than one that doesn't.
   No collision risk with `isKitSku` (`lib/masters/kit-sku.ts`), which requires
   `sku_type = 'Gift Kit'` **and** `subcategory = 'Kit'`.
4. **Split children lose all value — pre-existing.** `insertSplit`
   (`lib/queries/purchase-orders.ts:716-719`) writes no `unit_price` and no
   `total_amount`. Irrelevant for NPD POs, which have none either; reporting it
   because it silently halves the value of any *priced* PO that gets split.
5. **Two dev/prod divergences to respect:** `master_mfgs` ids and codes differ
   above id 16, and the migration is dev-only until separately approved.
