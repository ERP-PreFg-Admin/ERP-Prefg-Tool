# PO bulk upload — price at upload, flag unmapped SKUs and incomplete costing

## Context

A PO_BULK CSV is priced only at **approval** today (`poBulkHandler.applyAndArchive`
→ `makePoRateResolver`, `lib/approvals/handlers/purchase-orders.ts:48,129`). The
uploader never sees a rate, and two facts that matter are only in server logs:

- **SKU not mapped at that manufacturer** (no recipe in `master_recipe_mfg`) →
  the PO is raised unpriced, logged `PO_RATE … No agreed rate at all`.
- **Costing incomplete** (RM/PM lines without a rate) → the PO is raised at an
  understated rate, logged `partial: true`.

Goal: work the price out **when the file is uploaded**, show it per row in the
preview with a note for either case, and raise the PO at exactly that price.

Decisions taken with Ajay (2026-10-06):

| | |
|---|---|
| Unmapped SKU | **Warn, still upload.** Raised unpriced, as today. Nothing blocked. |
| Costing note | **Preview + staged CSV only.** Never written into `purchase_orders.remarks` — that column is printed in the manufacturer mail and its Excel. |
| Which price | **Upload-time, locked.** The server prices the rows when staging and writes them into the staged CSV; the approver approves the number they see. |

## Sequencing and gates

1. **Pricing classifier** (pure) + unit test. No behaviour change.
2. **Server pricing at upload** — preview action and staging both call one
   function. Gate: preview a real file on dev and compare every rate against
   Agreed Final Costing for that manufacturer.
3. **Handler reads the locked price**, with the fallback for files staged before
   the deploy. Gate: DB test green for both paths.
4. **Preview shows notes without blocking** (shared `CsvImportDialog`, additive).
5. Deploy. **No DDL** — nothing here touches the schema.

Owner: Claude writes all of it (frontend is Claude's by default; backend on your
go-ahead). Rollback is a revert — no data migration to undo.

## Design

### 1. One classifier — `lib/po/po-rate-note.ts` (new, pure)

Takes the `AgreedRate` (or its absence) and returns
`{ unitPrice, totalAmount, status, note }`, where `status` is one of
`priced | partial | unmapped | zero`. The rounding stays exactly as
`po-rate.ts:71-72` does it today (paise before the multiply), moved here so the
preview, staging and the legacy fallback cannot round differently.

| status | When | Price | Note shown |
|---|---|---|---|
| `priced` | full costing | rate | `₹123.45 × 5,000 = ₹6,17,250` |
| `partial` | `rm/pm_lines_without_rate > 0` | rate (understated) | `… — costing incomplete: 2 RM, 1 PM lines without rate` |
| `unmapped` | SKU absent from the mfg's agreed-rate map | none | `Not mapped at MFG-005-NGE — no recipe, will be raised unpriced` |
| `zero` | mapped, total 0 | none | `Costing totals ₹0 — will be raised unpriced` |

`makePoRateResolver` keeps its signature and its logging and delegates to this,
so the single-PO Add dialog (`app/api/v1/purchase-orders/route.ts:142`) is
unchanged.

### 2. Upload — `app/api/v1/purchase-orders/route.ts`

A shared `priceBulkRows(rows)` resolves `mfg_code → id` once per code, then the
classifier per **create** row (blank `po_no`). Update rows are not priced — the
update path never touches price — and get the note `Update — price unchanged`.
Rows the handler would skip get a note saying so: `Manufacturer X not found` /
`SKU not found — will be skipped`.

- **Preview:** the dialog already POSTs `{ action: "check_duplicates", rows }`
  after parsing when `enableDuplicateCheck` is on. The PO route answers it with
  `{ notes: { [rowIndex]: string[] } }`. Reuses the existing hook; no new route.
- **Staging (`"rows" in body`):** before `uploadRowsAsCsv`, run `priceBulkRows`
  again **server-side** and write four columns into every row:
  `unit_price`, `total_amount`, `costing_note`, `priced_at`. Any `unit_price` the
  client sent is **overwritten** — the price stays server-resolved, the rule
  `po-rate.ts:4-6` exists for.

### 3. Approval — `lib/approvals/handlers/purchase-orders.ts`

Create path: if the row carries `priced_at`, use its `unit_price` /
`total_amount` (blank = NULL). Otherwise resolve as today. `priced_at` is the
marker because only the server writes it; its absence means a file staged before
this deploy. The approver sees the four columns in the existing CSV preview
(`app/approvals/CsvPreviewDialog.tsx`) — verify it renders all columns.

### 4. Preview — `components/masters/CsvImportDialog.tsx` + `field-config.ts`

`isFlagged` (`field-config.ts:225`) treats **any** `_remarks` as blocking, so
pricing notes cannot go there or every partial-costing row would be dropped from
the upload. Add an optional `_notes: string[]` to `ParsedRow`, filled from
`data.notes`, rendered in the existing Remarks cell in a muted/amber style, and
**not** read by `isFlagged`. Other consumers never send `notes`, so they are
unchanged. Turn on `enableDuplicateCheck` for the PO dialog
(`PoProcurementClient.tsx:335`).

## Risks

1. **Approvals pending at deploy** were staged without prices → they hit the
   fallback and re-resolve at approval, exactly as today. No breakage, no backfill.
2. **Costing changes between upload and approval** are deliberately not picked up
   — that is the "locked" decision. An approver who wants today's rate rejects
   and the uploader re-uploads.
3. **Preview vs staging can differ** if costing changes in the seconds between
   them. Staging is the one that counts, and it is what the approver sees.
4. **A crafted request could send `priced_at`.** Harmless: staging overwrites all
   four columns on every row before the CSV is written, and the handler only ever
   reads the server-written file from S3.
5. **Shared dialog.** `_notes` is additive and optional; every other bulk upload
   (SKU, RM, PM, vendor, mfg, recipe) keeps today's behaviour.

## Verification

- `npm test` — classifier truth table: full, partial, unmapped, zero, rounding
  (rate × qty equals the printed amount).
- `npm run test:db` — handler: a row with `priced_at` uses the CSV price (even
  when costing has since changed); a row without it re-resolves; an unmapped row
  lands `unit_price IS NULL`.
- `npm run lint:changed`, `npx tsc --noEmit --incremental false`.
- Manual on dev: upload a file with one fully costed SKU, one partial, one not
  mapped at that manufacturer, and one update row → preview shows four notes and
  nothing is blocked → approval CSV shows the four columns → approved POs carry
  exactly the previewed rates; no costing text in any PO's remarks.
