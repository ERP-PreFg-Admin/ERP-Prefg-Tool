# MFG Overview → Dispatch History: facility-wise view — plan

**Status:** built 2026-10-19, with D1 = facility and D2 = filter added. Tests, tsc and eslint are clean. On prod data for the last 30 days, the totals match a plain SUM (2,802,440.25), with every invoice resolving to a facility (23 of them). Waiting for Ajay's dev click-through before commit.

## What's missing

Dispatch History groups invoiced qty only by **manufacturer × SKU** (`supplierInvoicesSql.dispatchedBySkuMfg`). Where the goods went is never selected, so no view can split by facility. The toggle offers Lines / By MFG / By SKU.

## What "facility" means here

A facility is a **location × legal entity** (`details_warehouse_entity`, 18 active). This matches the MFG × Facility Mapping tab, where Gurgaon is `GGN_WAREHOUSE` under Pep and `HYP_B2B_GGN` under Kreative.

An invoice carries both halves:
- `destination`, which is the `master_warehouse.name`;
- `buyer_gstin`, whose PAN is the entity billed.

`warehouse.facilityByDestinationAndPan` and the invoice list already resolve a facility this way. An invoice that doesn't resolve still shows, under its destination name with no facility code. Nothing is dropped.

## Changes

| # | Where | Change |
|---|---|---|
| 1 | `lib/queries/supplier-invoices.ts` → `dispatchedBySkuMfg` | Add `si.destination`, plus `dwe.facility_code` and `e.code` (entity) through LEFT JOINs on `master_warehouse` / `master_entity` (by PAN) / active `details_warehouse_entity`. Group by them too. The grain becomes mfg × SKU × facility. Scope and filters are unchanged |
| 2 | `lib/services/mfg-overview.ts` | Map the 3 new fields onto `DispatchLine` |
| 3 | `overview-model.ts` | Add `groupByFacility` (facility, location, entity, MFGs, SKUs, qty) and a `"facility"` value for `DispatchView`. **Fix `groupByMfg` / `groupBySku`:** they count `+1` per line, which is only right while a line is one (mfg, SKU). They must count distinct SKUs / MFGs, or a SKU shipped to 2 facilities is counted twice. `dispatchStats` gains `facilities` |
| 4 | `DispatchHistory.tsx` | Add a 4th toggle, **By Facility**, in the existing segmented control. The Lines view gets a Facility column. Add a "Facilities" stat beside the existing ones. Same table and card, with no new panel |
| 5 | `app/api/v1/manufacturing/dispatch/export/route.ts` | Columns for the `facility` view, and a Facility column on `lines`, so the export matches the screen |
| 6 | `tests/unit/mfg-overview-model.test.ts` | Cover `groupByFacility`, and the distinct-count fix with one SKU going to two facilities |

No DDL and no new route. `app/**` still reads only through `lib/services`.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Group by **facility** (location × entity, 18 rows), or just **location** (~10, so Pep and Kreative Gurgaon merge)? | **Facility**, to match the mapping tab and Uniware. The row shows the location name next to the code, so it still reads by place |
| D2 | Also add a **Facility filter** dropdown next to the manufacturer filter? | Not now; the view is what was asked for. It's a small add later, done client-side like the SKU search |

## Gates

1. Go-ahead on D1/D2.
2. Build, then run `npm test`, `npm run lint:changed` and `npx tsc --noEmit --incremental false`.
3. Ajay clicks through on dev. I compare one day's By-Facility total against By-MFG to show they sum to the same total.
4. Commit: `feat(mfg-overview): facility-wise dispatch view`.

## Risk

- **Lines view gets longer:** a pair shipped to 3 facilities becomes 3 rows. That's the point, but the Lines export changes shape too.
- **Destination spelling:** `invoice_mfg.destination` has no FK. A destination spelled differently from `master_warehouse.name` shows as its own row, with no facility code. That surfaces bad data rather than hiding it.
