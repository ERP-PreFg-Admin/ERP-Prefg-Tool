# Misc. cost by SKU, checked at upload, re-uploads become price updates

Three changes to `bom_misc` (JW / Shrink / Shipper / Utility / Margin / RM & PM wastage), shipped together:

1. **Keyed on SKU × manufacturer**, not recipe × manufacturer.
2. **Validated at upload**: a bad file is refused before an approval exists, not when the approver clicks Approve.
3. **A row for a cost that is already live updates its price on approval**, and the old price is archived. The uploader confirms twice before such a file is submitted.

## Why
- **Recipe keying loses costs.** A new recipe version starts with no misc costs; the old ones stay on the discontinued recipe and price nothing (2 live cases on prod). The CSV lookup `sku_code → recipe` is `LIMIT 1` with no ORDER BY, so it can land on the old recipe (3 SKU × mfg pairs at risk).
- **Approval-time-only checks.** The bulk route stages the file without reading a row; every check runs on Approve. #1425 (Ananya, 24 rows) told the uploader "staged" and only the approver saw it fail.
- **No way to change prices in bulk.** A row for a live cost is refused ("edit that line instead"), so a price revision across a manufacturer means one edit per line. And `bom_misc` is edited in place with no archive, so a superseded price is lost.

## Data today (read-only check, 2026-10-22)
| | prod | dev |
|---|---|---|
| rows | 894 active, 2 rejected, 1 inactive | 56 active |
| rows whose recipe has no SKU | 0 | 0 |
| live collisions once collapsed to SKU | **5**, all Reve `MCaf370`, one per type | 0 |
| pending MFG_MISC / MFG_MISC_BULK approvals | 0 | 0 |

The 5 collisions are the discontinued `MCaf370-RM1-PM1` (ids 1402/1448/1494/1540/1586) beside the active `MCaf370-RM2-PM1` (ids 2428–2432). JW/Shrink/Shipper match; wastage differs (old 0.03 / 0.01, live 1.00 / 2.00). **Proposal: keep the active recipe's lines and set the five old ones `inactive`.** Costing already prices the active ones, so no costed number moves.

## How a bulk row is classified
Run by one shared function, `planMiscRows(mfgId, rows)` (new, `lib/costing/misc-plan.ts`), at three points: the preview, the bulk submit, and approval.

| Row | Outcome |
|---|---|
| Unknown SKU, SKU not made by this mfg, bad type / cost / date | **Error**: blocks the file |
| Same SKU + type twice in the file | **Error** |
| No live line for (mfg, SKU, type) | **New line** |
| Live line exists, cost or effective_from differs | **Update**: old → new shown; remarks required |
| Live line exists, cost and effective_from identical | **Error: "already live, nothing to change"**, left out (this is what #1425 was) |
| Live line is `in_review` (a pending single edit) | **Error: "pending approval, wait for it"** |

## Upload flow
1. **Preview (new `check_duplicates` action).** The Misc. Cost CSV dialog turns on `enableDuplicateCheck` + `requireAllValid`. Errors show per row in red. Updates land in the dialog's existing **Edits** table with old → new cost and date. Nothing is staged.
2. **Double confirm, only when the file has updates.** Upload opens:
   - **Dialog 1:** "N rows will replace live prices", listing SKU · type · old → new. Buttons: Cancel / Continue.
   - **Dialog 2:** "Confirm again: N live prices for <mfg> will be replaced once approved. The current prices will be archived." Buttons: Go back / Replace prices.
   A file with only new lines uploads as today, with no dialogs.
3. **Submit (`bulk`).** The server re-runs `planMiscRows`; the dialog is never the guard. Any error → 400 with the reasons, nothing staged. Updates present without `confirm_replace: true` in the body → 409. Otherwise one `MFG_MISC_BULK` approval, as today. The staged CSV carries each update row's `line_id` and `old_cost` / `old_effective_from`, so the approver sees what is being replaced.

## On approval
`mfgMiscBulkHandler` re-runs `planMiscRows` against the live data, still all-or-nothing:
- **New line:** inserted `active` (as today).
- **Update:** the live row's old values are first copied into a **new `bom_misc` row with status `archived`**, keeping the old cost and `effective_from`, with `effective_till` = the new effective_from (`supersededOn`). Then the live row is updated in place, so its id (and every approval pointing at it) stays the same. Archived rows price nothing (costing reads `active` only) and sit outside the live-slot unique index. Who approved it and why stay on the approval record; `bom_misc` has no columns for them.
- **Live price changed since upload** (current ≠ staged `old_cost`): that row fails as "changed since upload, re-upload". Archiving and overwriting a price the uploader never saw is the one thing this must not do.

Single-line edits (`MFG_MISC`, the Edit dialog) archive the same way on approve when the cost changes, so every superseded price is kept, whichever path changed it.

## Sequencing and gates
1. **Decision — you:** OK to inactivate the five old MCaf370 lines? ⛔
2. **Dev DDL — me** (`prisma/alter_bom_misc_sku_id.sql`), run on dev only, then stop: ⛔
   - add `bom_misc.sku_id` + index `(mfg_id, sku_id, type)`, backfill from `master_recipe.sku_id`, then `NOT NULL`;
   - `bom_id` → `NULL`, kept for history, no longer written;
   - a functional UNIQUE index on the live slot (`(mfg_id, sku_id, type)` while `active`/`in_review`), so one live line is enforced by the database;
   - status ENUM gains `archived` (superseded prices stay in `bom_misc`; a separate history table was created and dropped on dev, never on prod).
   ✅ Done on dev 2026-10-22.
3. **Code on dev:** ✅ written 2026-10-23. tsc, `npm test` (1082/1082), the misc DB tests (6/6) and `npm run build` pass. The click-through is still to do.
   - `npx tsc --noEmit --incremental false`, `npm test`, `npm run test:db`, `npm run lint:changed`, `npm run build`;
   - click-through: a new-only file; a file with updates (both dialogs, approve, check the archive row); a bad file refused at preview and at submit; a stale update refused at approve.
   ⛔ Your sign-off.
4. **Prod, with a separate go-ahead:** inactivate the 5 MCaf370 lines → same DDL → deploy **straight after**. ⛔
   ✅ DDL done on prod 2026-10-23. Before it ran, 15 duplicate live lines were set to `discontinued` (Ajay's call: old versions stay, only one is active). They were the 5 MCaf370 lines plus 10 new Vedic lines from 2026-10-22: MCaf285_WB / MCaf382_WB on the old PM1 recipe, ids 2538–2547, identical to PM2. Snapshot is in the scratchpad. After the DDL: 927 rows, `sku_id` all filled and equal to the recipe's SKU, 0 live collisions. **Deploy is still pending.**
   The DDL must land first, because the new code reads `sku_id`. Between the two, old code can still **read** (costing and the tab are fine), but **adding** a misc line fails: `sku_id` is NOT NULL and old `insertMisc` doesn't set it. Keep the gap to minutes, and run it with no misc upload in progress. (Dev is in that state now until the code lands.)

## Code changes
- **Costing reads (the 6 readers don't change):** `selectMiscCostsByMfg` joins `bom_misc.sku_id` to every recipe of that SKU and still returns `recipe_id, type, cost`. A new recipe version is priced with the existing lines automatically.
- **Misc. Cost tab:** queries join SKU directly; `archived` rows land in the tab's existing Archive view (not editable) and are left out of the current-rates export; the Recipe column is dropped; the Add dialog picks a SKU this manufacturer makes; the bulk template gains an optional `remarks` column (required on update rows).
- **`/api/v1/manufacturing/misc-costs`:** `create-misc` takes `sku_id` (brand guard → `assertSkuIdInBrandScope`); new `check_duplicates`; `bulk` validates and requires `confirm_replace` for updates. Live-slot lookup keyed on `sku_id`.
- **`CsvImportDialog`:** a new opt-in prop for the two-step confirm when the file has edits. Other masters are unaffected.
- **Handlers:** `mfgMiscBulkHandler` gets new + update + stale check; `mfgMiscHandler` archives on approve.
- **Approvals:** the `MFG_MISC` label joins SKU; the bulk card shows update rows as old → new.
- **Tests:**
  - unit tests for `planMiscRows`, with every row in the table above;
  - DB tests: an update archives then overwrites; a stale update is refused; a new recipe version inherits the misc cost; the unique index refuses a second live line;
  - `tests/db/misc-cost-approval.test.ts` moves to `sku_id`.
- `prisma/schema.prisma` and the CLAUDE.md `bom_misc` note are updated.

## Risks
- **Deploy order:** new code before the DDL breaks the Misc. Cost tab and every costing page. Gate 4 sets the order.
- **A wrong price can now be replaced in bulk.** Mitigated by the two confirms, the old → new list in both dialogs and on the approval card, and the archive, which means any replaced price can be restored.
- **One misc cost per SKU across recipe versions is forced.** Different JW for two live formulations of one SKU at one mfg cannot be held. That case doesn't occur in today's data.
- **Archived prices are not yet read by costing.** Past-date pricing (agreed rates `asOf`) still uses the live cost, as today. Reading the `archived` rows there is a follow-up.
- **Any new query on `bom_misc` must filter status.** Archived rows share the table, so an unfiltered read would show or count superseded prices. Every existing costing read already filters `active`; the Misc. Cost list does not and is changed.
- Functional unique index: RDS is 8.0.46, which supports it (verified on dev).
