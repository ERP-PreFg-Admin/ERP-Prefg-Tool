# Bulk PO upload — a `po_type` column (normal · impromptu · npd · tech_transfer · cpr)

## Context

Ajay, 2026-10-06. The PO bulk CSV gains a **po_type** column. `normal` and
`impromptu` exist; three new **special types** — `npd`, `tech_transfer`, `cpr` —
are raised at **price 0** (a NULL price can't go on the PDF), must be **mapped**
at that manufacturer (else a remark), and may be raised **only once per
SKU ↔ manufacturer pair**; a repeat is blocked. This **supersedes**
`docs/claude-plans/plan-out-a-way-snoopy-lantern.md` (remarks-based NPD).

Builds on two uncommitted pieces of today's work, which land first:
upload-time bulk pricing (`priceBulkRows`, `classifyRate`) and the GST total
(`amount_pre_gst`, `poTotal`).

## Decisions (Ajay, 2026-10-06)

| | |
|---|---|
| Values | `normal`, `impromptu`, `npd`, `tech_transfer`, `cpr` (spelt **cpr**). Blank / column absent → `normal`. Anything else → flagged, blocked. Type comes **only** from this column — remarks are never parsed |
| Special price | **Stored 0**: `unit_price = 0`, `amount_pre_gst = 0`, `total_amount = 0`, even if the SKU is costed |
| Mapping | "Mapped" = an **active recipe at that manufacturer** (`master_recipe_mfg`, the same lookup that prices normal POs). Not mapped → **raised anyway**, remark in preview + staged CSV only (never the PO's remarks) |
| Once per pair | Key **(sku_code, mfg_id, po_type)** — **per type**. Counts **live** special POs (any status but `cancelled`), excluding split children. A repeat → that **row flagged and left out**, rest of the file uploads. In one file, the first row wins. A **normal priced PO is always allowed** |
| Unknown SKU (not in master_skus) | **Flagged red + a highlighted toast** ("N rows have SKUs not in SKU Master"), row left out |
| Remarks | **Required** for `impromptu`, `npd`, `tech_transfer`, `cpr`; blank → flagged |
| Impromptu in bulk | Like a single impromptu: remarks required, priced from costing, **IMP** PO-number tag; raised on PO_BULK approval |
| PO number | Special types use the normal `-PO-` tag; the type shows as a badge |
| Update rows (with PO No.) | **May not change the type** — a different po_type is flagged |
| Splits | Children **inherit the type and price 0**; they don't count against the limit |
| PDF | Special types: declaration → "This is a <NPD / Tech Transfer / CPR> order. Pricing will be confirmed separately; the supplier's invoice governs." 0.00 amounts print as they are; GST % label hidden |
| Invoice three-way | A special PO shows **"No agreed rate (<type>)"** — never a variance, never ₹0 goods |
| Update rows (2026-10-07) | A CSV may set status only to **raised, cancelled or short_closed** (receipt statuses come from receiving). A **draft** — stored draft, or raised but not yet mailed (`isDraftPo`) — may be edited freely. Once mailed (or otherwise past draft), a CSV may only **cancel or short-close**: any real change to dispatch date, destination or remarks, or a re-raise, is flagged. Compared with the PO's current values, so a re-uploaded export isn't blocked by unchanged columns. Checked at upload **and** again at approval (`bulkUpdateBlock`) |
| Destination (2026-10-07) | **Required** on every new row. Must be an **active** `master_warehouse` (matched case-insensitively, stored in the warehouse's own spelling) and must **serve the SKU's legal entity** — the same `destinationAllowed` rule as single Add PO. An update row's new destination gets the same checks against the PO's SKU; blank keeps it. All of these are blocking flags |

## Sequencing and gates

1. **Migration on dev** — `po_type` ENUM gains `npd`, `tech_transfer`, `cpr`. Stop.
   Prod: own go-ahead, **before** the deploy (MySQL rejects unknown ENUM values).
2. **Pure rules + unit tests** — type parsing, the special 0 price, row verdicts.
3. **Upload preview + staging** — type, price, mapping note, once-per-pair,
   remarks rule, unknown-SKU flag + toast. Gate: dry run on dev data.
4. **Approval** re-checks once-per-pair inside its transaction (a second upload
   may have been approved in between). Gate: DB test.
5. **Splits, PDF, invoice check, UI badge/filter.**
6. Deploy after the GST + bulk-pricing work is committed and its prod migration
   has run.

## Design

### 1. Migration — `prisma/add_special_po_types.sql`
`ALTER TABLE purchase_orders MODIFY COLUMN po_type ENUM('normal','impromptu','inward','npd','tech_transfer','cpr') DEFAULT 'impromptu';`
— appended, so no ordinal moves; re-runnable. Sync `schema.prisma`.

### 2. Pure rules — `lib/po/po-rules.ts`
- `BULK_PO_TYPES`, `SPECIAL_PO_TYPES = ["npd","tech_transfer","cpr"]`,
  `isSpecialPoType()`, `parseBulkPoType(cell)` → type | `"invalid"` (blank → normal).
- `specialPoPrice()` → `{ unitPrice: 0, amountPreGst: 0, totalAmount: 0 }`.
  Needed because `poTotal` treats a rate ≤ 0 as **no price** (NULL).
- `poPrintedAmounts` — a 0-total special PO prints 0 / 0 / 0, not the "total +
  flat 18%" fallback, and reports "no GST label".

### 3. Pricing status — `lib/po/po-rate-note.ts`
`classifyRate` gains a `special` path checked **before** the rate: price 0, note
`npd — price 0; pricing to be confirmed`, plus `not mapped at <mfg>` when the
recipe lookup has no entry. `stagedPrice` returns the special zeros when the
staged `po_type` is special.

### 4. Upload — `lib/po/po-bulk-pricing.ts` (+ `app/api/v1/purchase-orders/route.ts`)
Per row, in order, producing **blocking** flags (`duplicates`) or **non-blocking**
notes (`info`) — the dialog already merges both:

| Check | Result |
|---|---|
| po_type invalid | **flag** |
| update row with a po_type ≠ the PO's | **flag** |
| remarks blank on impromptu / special | **flag** |
| SKU not in master_skus | **flag** + counted for the toast |
| special: live PO exists for (sku, mfg, type) | **flag** `npd PO already raised for <sku> at <mfg>: <po_no>` |
| special: earlier row in this file has the same key | **flag** |
| special, SKU has no recipe at the mfg | note `Not mapped at <mfg>` |
| priced / partial / unmapped / zero (normal, impromptu) | note, as today |

Staging writes the server-decided `po_type` into the CSV (client value
overwritten, like the price). New query `purchaseOrdersSql.selectLiveSpecialPo`
(`mfg_id, sku_code, po_type`, `status <> 'cancelled'`, `reference_po IS NULL`).

### 5. Approval — `lib/approvals/handlers/purchase-orders.ts`
Reads the staged `po_type`; re-runs the once-per-pair check on the open
connection (skip + skip-reason on a clash); PO number tag `IMP` for impromptu,
`PO` otherwise; `insertBulkPo` takes `po_type` as a parameter (hard-coded
`'normal'` today).

### 6. Splits — `app/api/v1/purchase-orders/[id]/split/route.ts`
`insertSplit` takes `po_type` (hard-coded `'normal'` today). Special parent →
children get the parent's type and `specialPoPrice()`; others unchanged.

### 7. PDF — `po-document.tsx`, `split-po-document.tsx`
`po_type` added to `selectForEmail` / `PoEmailRow`. Special → new declaration,
GST % label hidden; amounts print 0.00.

### 8. Invoice three-way — `lib/invoice/three-way.ts` (~:364)
Treat `isSpecialPoType(po_type)` like `po_unit_price == null`: unpriced, labelled
with the type. Add `po_type` to the query that feeds it.

### 9. UI
- `po-bulk-fields.ts` — `po_type` select field (5 options, blank = normal) +
  remarks rule.
- `CsvImportDialog` — after the preview check, a highlighted toast when any row
  is flagged "SKU not in SKU Master" (count + download-flagged hint).
- `po-types.ts` union; `PoDataRow.tsx:166` badges (NPD / TT / CPR beside IMP);
  PO Type filter options.

## Risks

1. **Concurrent approvals** — two files with the same special pair, both staged
   before either is approved. The approval-time re-check catches the second.
   The rule lives in app code (a unique index can't exclude cancelled rows) and
   is pinned by a DB test.
2. **0 is a stored price** — anything summing or comparing `unit_price` must
   treat special types as "no agreed rate". Known readers: three-way (step 8);
   open value sums 0 (correct). Grep `unit_price` readers before shipping.
3. **Most NPD SKUs have no recipe yet** → the "not mapped" note will be common;
   it never blocks.
4. **Pending PO_BULK approvals** staged before the deploy have no staged
   `po_type` → normal, as today.
5. Depends on the GST + bulk-pricing work (uncommitted) and its prod migration.

## Verification

- `npm test` — `parseBulkPoType` truth table; special price 0/0/0;
  `poPrintedAmounts` for a 0 special PO; row-verdict table above.
- `npm run test:db` (withRollback) — second live npd for a pair blocked, a
  cancelled one frees it, per-type independence (npd + cpr on one pair allowed),
  same-file duplicate, approval-time re-check, split children inherit type at 0
  and don't trip the limit.
- `npx tsc --noEmit --incremental false`, `npm run lint:changed`.
- Dev manual: upload a file mixing all five types, one unknown SKU, one repeat
  npd → preview shows flags/notes and the toast → approve → POs carry the right
  type, 0 price, badge; PDF shows the new wording; a split of an npd PO yields npd
  children at 0.
