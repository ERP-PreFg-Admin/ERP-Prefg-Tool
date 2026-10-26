# Reporting — independent review (data integrity audit)

**Status (2026-10-26):** a read-only audit by a reviewer independent of the inventory and design work. No DB queries were run. Prod figures are quoted from docs and memory notes. Each finding gives a **report rule** (how the Reports tab handles it) and states whether it **blocks** Phase 1.

## Critical

| # | Finding | Evidence | Report rule | Blocks Phase 1? |
|---|---|---|---|---|
| C1 | Every invoice receipt is stored twice: in the referenced PO's `received_qty` **and** as an inward PO with `qty = received_qty`. Existing screens that sum `purchase_orders` with inward rows included are inflated: PO Inwarding summary cards, observability business metrics, `selectMonthlyPoSummary*`, `overviewByMfg`. | `lib/invoice/invoice-inward.ts:186,224-229`; `po-inwarding/page.tsx:61-72`; `lib/services/business.ts:65-70`; `manufacturing.ts:192-247` | Ordered/open from `po_type <> 'inward'` masters only. Receipts from `RECEIVED_TOTAL_EXPR` (PO side) or invoice lines (invoice side), never both. A DB test pins it. | No: handled by design |
| C2 | Splits: the master keeps full qty and value, and each child is priced too. `selectMonthlyPoSummary*`, `selectAll` and the digest's `posMailed` count both. | `purchase-orders.ts:14-22,32-52`; `daily-digest.ts:14-18` | `MASTERS_ONLY` + `CHILD_AGG_JOIN` + `RECEIVED_TOTAL_EXPR`, exported and reused, not rewritten | No: handled |
| C3 | `total_amount` is six things: GST-incl, legacy pre-GST, NULL (455 unpriced), 0 (special), invoice totals (inward), and values touched by the 10-23 flip. | `prisma/add_po_gst_columns.sql`; `docs/po-total-gst-plan.md:34-52,110`; memory `project-po-total-flip-2026-10-23` | **Never read `total_amount`.** Pre-GST = `amount_pre_gst`, else `unit_price × qty`. Incl. GST = pre-GST × (1 + gst/100). Price class column. DQ-01 check #3 is the flip health check. | No: handled. The "~307" figure is **unconfirmed** |
| C4 | Invoice line export leaks other brands: the scope check passes when **any** line is in scope, and every line is returned. | `supplier-invoices.ts:79-88,448-476`; `invoice-guard.ts:40-51` | Reports filter brand per line | No for reports. **The existing export is a separate fix** |

## Major

| # | Finding | Report rule |
|---|---|---|
| M1 | "Open" is defined three ways (`overviewByMfg` counts short_closed, unmailed and inward; `ongoingByMfg` counts short_closed; `summaryStats` uses the display status). Auto-close leaves up to min(10%, 100) short as `received`. Cancel and close don't check receipts or live children. | One definition (decided): display status ∈ raised/punched/partially_received, non-inward masters. "Short-closed qty" is its own measure in PO-02 |
| M2 | Soft reverts are not filtered everywhere (invoice list/export, `invoicesInwarded`). Reverted inward POs keep their qty. Uniware can cancel inward POs with no history. | Every invoice report: `reverted_at IS NULL`. PO reports exclude status `reverted` |
| M3 | Invoice data is incomplete: 16 of 52 invoices lost lines in Sept, `invoice_total` is not reconciled to lines, 16 backfilled inward POs were never mirrored. | INV-01 surfaces total-vs-lines as an exception; it's never hidden |
| M4 | History is partial: no create rows; cancel/close only from 2026-10-26; rate history only from the first overwrite; no inventory history. | Reports state their history start. No "as of past date" PO reports in Phase 1 |
| M5 | Four time bases; `summaryStats` overdue uses UTC `CURDATE()`. | Reports compute "today" in IST in TS and pass it as a parameter. UTC columns are filtered through `istDayWindowUtc` |
| M6 | Costing: `bom_misc.cost` mixes ₹ and %; edits hide lines from costing until approval; `selectMiscCostsByMfg` fans out to every recipe version. | Costing reports are Phase 2. They reuse the costing TS, never a SQL SUM over `bom_misc` |
| M7 | Entity attribution: PO via SKU→brand, invoice via GSTIN PAN. | Each report names its rule in Definitions |
| M8 | Six exports use the raw grant while their lists use the brand switcher. `approvals/entity-history` has no entity scope; `route-scope.test.ts` only sees `[id]` path segments. | Report page and export share one service. **The existing gaps are separate fixes** |
| M9 | `SELECT_COLS` has 7 correlated subqueries per row. There are no indexes on `approvals(module, entity_id)`, `purchase_orders(po_type, status, date)` or `history_pos(field_name, changed_on)`. `idx_po_reference_po` is missing on prod. | Report SQL avoids `SELECT_COLS`. Indexes proposed in T2 only after a dev `EXPLAIN`. `invoice_items_mfg(received_against_po_id)` **is already indexed** (`idx_sii_received_against`) |

## Minor
- `schema.prisma` isn't a data dictionary (pre-rename names).
- Mfg ids diverge between dev and prod from id 16, so keys go on `master_mfgs.code`.
- Brand exists twice on SKUs (`brand` text, `brand_id`).
- `po_type` defaults to `impromptu`.
- GRN `quantity` is gross.
- `cost_master_pm_mfg` has a collation mismatch.
- `destination` is free text (stable, because warehouse names are immutable).

## Outside the repo
- `../uniware_sku_export/fetch_sku_details.py` has hard-coded Uniware credentials. **Rotate them and move them to env.** The values aren't repeated here.

## Sign-off condition
Every Critical and Major item is either handled by a report rule above (verified by the DB tests in the implementation plan) or listed as an existing-screen fix outside this scope. Remaining **unknowns** to settle on dev before T4:
- whether `history_pos.changed_on` is really ~5h30 off on prod
- the real count of POs where `total_amount = 0 AND amount_pre_gst > 0` (a read-only prod check, on Ajay's go-ahead)
