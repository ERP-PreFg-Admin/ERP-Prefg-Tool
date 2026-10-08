# MFG Overview → three tabs: Open POs · Dispatch History · MFG x Facility Mapping

## Context
`/po-tracking/mfg-overview` currently stacks the manufacturer cards and this month's PO summary (`ManufacturingOverviewClient`) on top of the SKU × Facility matrix. Ajay wants the page rebuilt to match his two mockups:
- **Open POs:** a SKU × manufacturer matrix of open PO qty, flagging POs older than 90 days.
- **Dispatch History:** what manufacturers shipped over a date range.
- **MFG x Facility Mapping:** the existing `MfgFacilityMatrix`, unchanged.

Decisions already taken:
- A dispatch is a **supplier invoice** (`invoice_items_mfg.qty` dated by `invoice_mfg.invoice_date`).
- The old cards and monthly summary are **replaced**, not kept above the tabs.
- Clicking a ">90d" chip or a matrix cell opens a **PO list dialog**.

## Sequencing and gates
1. **Data layer:** new SQL, plus a new `lib/services/mfg-overview.ts`. ⛔ Gate: run each query on dev and reconcile Open POs against PO Procurement's open qty for one manufacturer before any UI is built.
2. **Page shell:** URL-driven tabs (`?tab=open|dispatch|mapping`, default `open`). The server page loads only the active tab's data. The tab lives in the URL because the matrix calls `router.refresh()` after a save or sync, and client-only tab state would reset to the first tab.
3. **Mapping tab:** mount `<MfgFacilityMatrix cells lines mappings canEdit>` as it is today. It's a pure move.
4. **Open POs tab + drilldown dialog + export.**
5. **Dispatch History tab + export.**
6. Checks, then hand over for a click-through. No DDL anywhere in this plan.

Ownership: frontend is mine. For backend (SQL, service, routes), per your last instruction ("you write"), I'll write it unless you say otherwise.

## Data layer
All reads go through **`lib/services/mfg-overview.ts`**, which is new. Today `page.tsx` imports `lib/queries/*` and `lib/query-timing` directly, which breaks the `erp/ui-data-boundary` lint rule. Moving the three facility-map reads into the service fixes that as a side effect. Scope comes from `getViewScope` (`lib/brand-view.ts`) and `scopeParams` (`lib/scope.ts`), the same as the page does today.

**Open POs:** add `openQtyBySkuMfg` to `purchaseOrdersSql` in `lib/queries/purchase-orders.ts`. It goes in that file so it can reuse the module-private fragments, and the numbers will match PO Procurement.
- Filter: `DISPLAY_STATUS_EXPR IN ('raised','punched','partially_received')`, which is the `open` pseudo-status from `statusMatchValues`. Plus `EXCLUDE_INWARD`, `MASTERS_ONLY` and `SCOPE_WHERE` (mfg, destination, brand).
- Grouping: `GROUP BY po.sku_code, po.mfg_id`.
- Columns returned:
  - `open_qty = SUM(GREATEST(po.qty − RECEIVED_TOTAL_EXPR, 0))`, the same expression `summaryStats` uses.
  - `open_pos` (count).
  - `old_pos` (count where `po.date < SQL_TODAY_IST − INTERVAL 90 DAY`).
  - SKU name and mfg code/name.
- Per-manufacturer ">90 days" chips and SKU totals are summed client-side from these rows, so there's one query and no drift between the cells and the chips.

**Drilldown:** add `openPosForSkuMfg` to the same file, returning row-level PO no, date, age in days, qty, open qty, display status and expected-on. Optional filters: `mfg_id`, `sku_code`, `older_than_days`. It's served by a new `GET /api/v1/manufacturing/open-pos` using `withGateway`, `access /po-tracking/mfg-overview viewer`, and `scope: { type: "mfg" }`.

**Dispatch:** add `dispatchedBySkuMfg` to `supplierInvoicesSql` in `lib/queries/supplier-invoices.ts`.
- Sums `ii.qty` from `invoice_items_mfg` joined to `invoice_mfg`.
- Filters: `invoice_date BETWEEN ? AND ?`, an optional mfg filter, and a SKU code/name search.
- Scope: the same mfg, destination and per-line brand rules as `INVOICE_WHERE`.
- Grouping: `GROUP BY si.mfg_id, ii.sku_code`.
- Before writing it, I'll check whether `invoice_mfg` carries a void/cancelled state that must be excluded.

## UI
- **Open POs tab** (`OpenPosMatrix.tsx`), styled like the mockup:
  - SKU code and name, total qty, then one column per manufacturer that has open POs in scope.
  - A sticky "POs older than 90 days" row of red chips.
  - A cell shows open qty, PO count and a red dot when it contains a >90-day PO; "—" when empty.
  - Rows ranked by total open qty, with SKU search, 25 per page and a horizontal scroll that keeps the SKU columns pinned.
  - Header cells use `HEAD_BG`/`HEAD_ROW_LOOK` (`components/ui/table.tsx`).
  - The chip or cell opens `OpenPoListDialog` (filtered to that manufacturer, or that SKU × manufacturer), which links through to PO Procurement.
- **Dispatch History tab** (`DispatchHistory.tsx`):
  - Filters: `DateRangePicker` with D-1 / 7D / 15D / 30D presets (IST via `todayIST`, default D-1 = yesterday), a manufacturer `FuzzySelect` (options from `purchaseOrdersSql.mfgOptions`) and SKU search.
  - The filters drive the URL, so the server re-queries.
  - A stats strip: dispatched qty with the date, distinct SKUs, manufacturers and lines.
  - A `SegmentedToggle` for **Lines / By MFG / By SKU**. These regroup the same rows client-side through a pure helper `dispatch-groups.ts`, with a total row.
- **Export:** `DownloadButton` points at `/api/v1/manufacturing/open-pos/export` and `/api/v1/manufacturing/dispatch/export`. Both use `buildXlsx` from `lib/export.ts` with column configs added to `lib/export-configs.ts`. Open POs exports as the pivot on screen. Dispatch exports the active view.
- **Not deleted:** `ManufacturingOverviewClient` and `selectMonthlyPoSummaryAllMfgs`. This page just stops mounting them. If nothing else uses them afterwards, I'll report it.

## Files
- **New:**
  - `lib/services/mfg-overview.ts`
  - in `app/po-tracking/mfg-overview/`: `OpenPosMatrix.tsx`, `OpenPoListDialog.tsx`, `DispatchHistory.tsx`, `dispatch-groups.ts`, `MfgOverviewTabs.tsx`
  - routes `app/api/v1/manufacturing/open-pos/route.ts`, `/open-pos/export/route.ts` and `/dispatch/export/route.ts`
- **Edited:** `app/po-tracking/mfg-overview/page.tsx`, `lib/queries/purchase-orders.ts`, `lib/queries/supplier-invoices.ts`, `lib/export-configs.ts`

## Risks
- **Two definitions of "open":** `overviewByMfg` uses raw status, but this tab uses display status. A raised PO that was never emailed is a draft and won't count. That's deliberate: it matches PO Procurement.
- **Wide matrix:** one column per manufacturer. It scrolls horizontally with the SKU columns pinned, and manufacturers with nothing open are hidden.
- **Dispatch date:** dispatch is dated by **invoice date**, not booking date. An invoice booked late lands on the day it was invoiced.

## Verification
- **Gate 1:** probe each query on `mcaff_prefg_dev` from the scratchpad. The Open POs total for one manufacturer must equal PO Procurement's Open-tab qty for the same manufacturer. Dispatch for a range must equal the sum of that range's invoice lines on `/po-tracking/invoices`.
- **Unit tests** in `tests/unit/`: `dispatch-groups` regrouping and totals, the D-1/7D/15D/30D preset ranges in IST (around the 00:00–05:30 edge), and the >90-day flag logic.
- **Route scope:** `tests/unit/route-scope.test.ts` must stay green.
- **Gates:** `npx tsc --noEmit --incremental false`, `npm run lint:changed` (page.tsx must now pass the data-boundary rule), `npm test`.
- **Manual:** Ajay clicks through all three tabs, a chip, a cell, each preset, each view and both exports. On the mapping tab, a save or sync must leave him on that tab.
