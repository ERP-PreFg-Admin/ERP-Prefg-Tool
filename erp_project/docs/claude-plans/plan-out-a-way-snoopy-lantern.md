> **SUPERSEDED 2026-10-06** by `docs/po-bulk-type-plan.md`: the PO type now comes from an explicit
> `po_type` CSV column (normal · impromptu · npd · tech_transfer · cpr), never from remarks.

# NPD Purchase Orders

> **Revised 2026-10-06.** Re-checked against the code after `badaabf` / v0.1.15
> and aligned with `docs/po-bulk-pricing-plan.md`, which this now builds on.
> What changed is listed at the end.

## Context

New products are ordered ~3 months ahead, before their recipe exists and before
any cost is agreed. Today that PO cannot be raised through the Add PO dialog:
`poCreateSchema` demands a positive `recipe_id`, the API rejects a non-`active`
SKU, the SKU picker `INNER JOIN`s `master_recipe_mfg` so an NPD SKU never
appears, and the rate is computed from Agreed Final Costing.

Decisions taken with Ajay:

| | |
|---|---|
| Entry path | **CSV bulk upload on the existing FG PO page.** No new page, dialog or permission slug. |
| How NPD is recognised | The CSV's existing **`remarks` column** — NPD files always say something containing "NPD". |
| Price | **None.** Stored as `unit_price = NULL`, never re-rated; the supplier invoice carries the truth. Applies even when the SKU already has costing. |
| SKU | If the code exists in `master_skus`, use it. If not, **insert a stub marked NPD** so it stands as a visible to-do: recipe and costs still owed. |
| Approval | The existing `PO_BULK` approval. |
| Uniware | Nothing to do — procurement POs are never pushed. |

## Sequencing and gates

**Depends on `docs/po-bulk-pricing-plan.md` landing first.** That plan prices
rows at upload and adds the non-blocking per-row preview note; NPD is one more
status in the same classifier and one more note in the same preview.

1. **Migration on dev only** — `po_type` gains `'npd'`. **Stop.** Prod needs its
   own go-ahead, and must run **before** the deploy (MySQL rejects an unknown
   ENUM value, so a deploy without it fails every NPD row).
2. **Detection + pricing status** (pure) + unit tests.
3. **Upload and approval path** — preview verdict, locked "no price", stub SKU,
   NPD PO number, `po_type = 'npd'`. Gate: the DB test below.
4. **Splits inherit NPD.** Gate: splitting an NPD PO on dev yields NPD children.
5. **PDF wording**, both templates. **Gate: Ajay approves the wording before the
   first NPD PO is mailed** — the first send freezes the PDF in S3.
6. **UI badge + filter.** Deploy.

## The decision

**NPD is a fourth `po_type`**, not a status and not a new column — exactly how
`inward` was added (`prisma/add_inward_po_type.sql`). One enum value buys
filtering, badging, reporting and the PDF branch.

`remarks` is parsed **once, at upload**, and the verdict travels in the staged
CSV and is stored as `po_type = 'npd'`. Nothing downstream ever does
`LIKE '%NPD%'`.

**No price is `NULL`, not `0`.** A stored `0` asserts "free" and slips past the
unpriced guard in `lib/invoice/three-way.ts:364` (`po_unit_price == null`),
valuing received goods at ₹0 instead of flagging them unpriced. Same shape in
`supplier-invoices.ts` (`SUM(rejected_qty * unit_price)`). The PDF and mail
layers already render a NULL price as `—`.

## What already works — do not touch

- **`expected_on` has no upper bound** — only backdating is refused.
- **`recipe_id` degrades to NULL** through `RECIPE_ID_FOR_LINE`, and every join
  from `purchase_orders` to `master_recipe` is LEFT.
- **`sku_code`, `unit_price`, `total_amount`, `recipe_id` are nullable.**
- **The bulk path skips the `status = 'active'` SKU gate** — it only checks the
  SKU exists (`handlers/purchase-orders.ts:112`), so a `new launch` stub passes.
- **`master_skus_status` already has `new launch`** (`schema.prisma:1322`,
  stored as the literal `"new launch"`).
- **`sku_type` is free text**, its dropdown built from `SELECT DISTINCT`, so
  `'NPD'` needs no migration and appears in the SKU Master filter on first use.
- **`overviewByMfg.open_value`** sums `COALESCE(total_amount, 0)` — an unpriced
  NPD PO contributes 0, honestly.
- **PO mails need nothing.** NPD lines sit in the normal Raised/Cancelled/Open
  tables; the Excel's Rate cell is already blank for a NULL price; an NPD send is
  not impromptu, so it keeps the Current Open table; the split summary mail has
  no price column.

## Changes

### 1. Migration — `prisma/add_npd_po_type.sql`

Header convention from `prisma/add_inward_po_type.sql`.

```sql
ALTER TABLE purchase_orders
  MODIFY COLUMN po_type ENUM('normal','impromptu','inward','npd') DEFAULT 'impromptu';
```

Appended last so no existing ordinal moves; keep `schema.prisma`'s
`purchase_orders_type` in sync. Re-runnable (a MODIFY to the same definition is a
no-op).

### 2. Detection — `lib/po/po-rules.ts`

```ts
/** NPD is declared in the uploader's remarks. Not \bNPD\b: "_" is a word char. */
export function isNpdRemark(remarks: string | null | undefined): boolean {
  return /(^|[^a-z0-9])npd([^a-z0-9]|$)/i.test(remarks ?? "")
}
```

### 3. Pricing status — `lib/po/po-rate-note.ts` (from the bulk-pricing plan)

Add a fifth status, **`npd`**, checked **before** any rate lookup: no price, note
`NPD — no price; the invoice governs`. This is what makes an NPD row on an
*already costed* SKU stay unpriced — today's `resolvePoRate` would price it.

### 4. Upload — `app/api/v1/purchase-orders/route.ts`

Inside the bulk-pricing plan's `priceBulkRows`, for each create row with
`isNpdRemark(remarks)`:

- status `npd` → staged `unit_price` / `total_amount` blank, `priced_at` set, and
  a new staged column **`po_type = npd`** (server-written, like the price — a
  client-sent `po_type` is overwritten).
- **Unknown SKU** → note `New SKU — will be created as an NPD stub (brand X)`
  instead of `will be skipped`. Needs the CSV `brand` cell; without it the row is
  **flagged** (blocking): a stub with a guessed brand is wrong silently.
- **Brand scope for new codes.** `assertSkuCodesInBrandScope`
  (`lib/brand-guard.ts:97`) only checks codes it finds, so a new code passes
  unchecked. For each NPD row with a new code, resolve its `brand` and
  `assertInScope(scope, "brand", brandId)`, rejecting the upload on a violation.
  It must be here: the handler runs as the approver, and the approvals queue is
  not brand-scoped.

The preview note per row is the mitigation for risk 1: the uploader sees the
NPD verdict before submitting.

### 5. CSV columns — `app/po-tracking/po-procurement/po-bulk-fields.ts`

Declare two optional fields, both used only for the stub: `brand` (explicit —
never `skuCode.split("-")[0]`) and `sku_name` (already an export column). The
`unit_price` column stays undeclared; the server writes it.

### 6. Approval — `lib/approvals/handlers/purchase-orders.ts`

Create path (`:98-138`), reading the staged columns:

- `const isNpd = row.po_type === "npd"` — the **staged verdict**, not a second
  parse of remarks, so approval cannot disagree with what the uploader saw.
- **Stub SKU.** Where `if (!sku) { skipped++ }` sits (`:112`): if `!sku && isNpd`,
  insert the stub and carry on with its brand. A non-NPD unknown SKU still skips.
  `skusSql.insertSku` (`lib/queries/skus.ts:301`) writes six columns and has no
  `sku_type` — add one.

  | Column | Value |
  |---|---|
  | `sku_code` | the CSV cell |
  | `name` | `row.sku_name \|\| skuCode` |
  | `brand` | the CSV `brand` cell |
  | **`sku_type`** | **`'NPD'`** — the to-do mark |
  | `status` | `'new launch'` — keeps it out of the Add PO dialog |
  | `created_by` | `approverId` |

- **Price** comes from the staged columns (blank = NULL), per the bulk-pricing
  plan. No rate lookup for NPD.
- **PO number:** `${brand}-${isNpd ? "NPD" : "PO"}-${yyyymm}-${seq}`
  (`:122`), matching the `IMP` tag in the create route.
- **`insertBulkPo`** (`lib/queries/purchase-orders.ts:732`) hard-codes
  `'normal'` — make `po_type` a parameter. It already takes `unit_price` and
  `total_amount`; its docstring (`:730`) still omits them — fix it in the same
  edit, since the new parameter changes the count. Keep `recipe_id`'s two
  resolver params at the tail.

### 7. Splits inherit NPD — **new**

`insertSplit` (`lib/queries/purchase-orders.ts:725`) stamps every child
`'normal'`. An NPD PO that is split would yield normal children: no badge, no
filter, and the ordinary price declaration on their PDF. Pass
`po.po_type === 'npd' ? 'npd' : 'normal'` from the split route
(`app/api/v1/purchase-orders/[id]/split/route.ts`), so only NPD changes and the
existing impromptu behaviour is untouched. Children carry no price already.

### 8. PDF — both templates

At no price every money cell already renders `—`. Two residual problems, in
**both** `lib/pdf/po-document.tsx` and `lib/pdf/split-po-document.tsx`:

- the GST row prints an `18%` label (`po-document.tsx:310`) beside `—` amounts;
- the declaration (`po-document.tsx:367`, `split-po-document.tsx:301`) affirms
  "the actual price of the goods" on a document that states none.

When `po_type === 'npd'`: suppress the percentage label and replace the
declaration with a pricing-to-be-confirmed line. **Wording is Ajay's call.**

Needs `po_type` on the PDF row: `selectForEmail` does not select it — add it
there and to `PoEmailRow` (`lib/pdf/po-letterhead.ts`). (`buildSelectByIds`
already selects it, since the impromptu mail change.)

### 9. UI — read-only

- `po-types.ts:73` — add `"npd"` to the `po_type` union.
- `PoDataRow.tsx:166` — an `NPD` badge beside the `IMP` one.
- `PoProcurementClient.tsx:~404` — offer `npd` in the PO Type filter.

No new tab, page, `lib/pages.ts` entry or `page_permissions` row.

## Deliberately not doing

- **NPD in the Add PO / Impromptu dialogs** — needs a non-recipe SKU picker and a
  relaxed `poCreateSchema.recipe_id`, roughly triple the diff.
- **Re-rating an NPD PO when costing lands** — the invoice carries the truth.
- **A PO-rate vs invoice-rate variance check** — none exists, and an NPD PO has
  no rate to compare.
- **Auto-clearing the NPD mark** on first recipe activation — see risk 3.

## Verification

```
npm test                                  # isNpdRemark + npd pricing status
npm run test:db                           # bulk handler + split, below
npm run lint:changed
npx tsc --noEmit --incremental false
npm run build                             # stop `npm run dev` first
```

- **`tests/unit/po-rules.test.ts`** — `isNpdRemark` true for `"NPD"`,
  `"npd trial batch"`, `"NPD-Q3"`, `"For NPD launch"`, `"NPD_TRIAL"`; false for
  `""`, `null`, `"expanded"`, `"unpdated"`.
- **Pricing-status unit test** — `npd` wins over a fully costed rate.
- **`tests/db/po-bulk-npd.test.ts`** (new, `withRollback`) — a staged NPD file
  with a costed known SKU and a new code: both POs `po_type = 'npd'`,
  `unit_price IS NULL`, `total_amount IS NULL`, `po_no` matching `-NPD-`; a stub
  with `sku_type = 'NPD'`, `status = 'new launch'` and the CSV brand; the known
  SKU's own `sku_type` untouched.
- **Split** — splitting that NPD PO yields children with `po_type = 'npd'`.
- **Manual on dev** — upload with `remarks = "NPD trial batch"`: preview shows the
  NPD note on both rows and the stub note on the new one → approve → two NPD POs,
  badge and filter work, no rate → SKU Master filter SKU Type = NPD lists the stub
  → preview PDF (normal and split) shows `—` prices, the new wording, no `18%`.

## Risks

1. **`remarks` is a human-typed trigger.** A file that means NPD but doesn't say
   so creates normal POs **priced from costing** — larger blast radius than when
   this was first written, since the bulk path now prices. The preview's per-row
   NPD note is the guard.
2. **Uniware vendor items.** `lib/mfg-facility-push.ts` refuses a vendor item for
   a SKU with no agreed costing, but the invoice-time inward PO needs one — so the
   recipe and rates must land before the first NPD delivery is invoiced. That is
   the real deadline the NPD to-do list counts down to.
3. **Nothing clears the NPD mark.** Once costing lands, someone edits `sku_type`
   in SKU Master (normal SKU approval). No collision with `isKitSku`, which needs
   `sku_type = 'Gift Kit'` **and** `subcategory = 'Kit'`.
4. **Approvals pending at deploy** carry no staged `po_type` → treated as normal,
   exactly as today. An NPD file uploaded before the deploy is not retro-detected.
5. **Dev/prod divergence:** `master_mfgs` ids differ above 16; the migration is
   dev-only until approved.

## What changed in this revision

- **Pricing:** the bulk path now prices from costing (`resolvePoRate`). The old
  "zero price needs no code" no longer holds — NPD must skip pricing explicitly
  (step 3).
- **Built on the bulk-pricing plan:** verdict, price and `po_type` are fixed at
  upload and staged, so approval reads them rather than re-deriving.
- **Splits (step 7):** `insertSplit` hard-codes `'normal'`; NPD children now
  inherit `'npd'`.
- **Split PDF** added to step 8; it has the same declaration.
- **Unknown SKU without a `brand` cell** is now a blocking flag, not a guess.
- **Line references** refreshed; `buildSelectByIds` already returns `po_type`.
