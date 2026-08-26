# Agreed Final Costing → split out an Analytics tab

**Status: implemented 2026-08-26.** Part 2 below (the Actions breakup column) is
planned, not implemented.

Two changes, one shared piece between them:

1. The three vendor-rate comparison tables (Approved / Cheapest / Most Expensive)
   leave the Agreed Final Costing tab for a new **Analytics** tab. Same columns,
   same tables, moved wholesale — decision taken 2026-08-26.
2. On Agreed Final Costing, clicking a SKU code or name **expands the row** and
   shows those same three scenarios for that one SKU.

The shared piece is the delta cells. Today they are rendered by three lines of
JSX inside `FinalCostingComparisonTable`, alongside its own private `fmtPct` /
`fmtDelta` / `deltaClass`. The expandable row needs the identical three cells, so
they move up into `costing-columns.tsx` next to `CostingCells` — which is exactly
what that file already exists for. **No new component and no new API route.**

Both tabs need all eight queries `FinalCostingTabContent` already runs: the
comparison rows are computed against the MRM rows, and the expandable row on the
costing tab needs the comparisons. So the data layer does not change at all.

Tabs are a `?tab=` search param on one page, so there is **no new
`page_permissions` row** and no scope work.

---

## 1. `TabBar.tsx` — one tab

`app/manufacturing/[mfgId]/TabBar.tsx:6-20`

```ts
export type MfgTab =
  | "active"
  | "misc_cost"
  | "rm_vendor" | "agreed_rates" | "final_costing" | "analytics"
  | "common_rms" | "vendor_ing_mapping"

const TABS: { key: MfgTab; label: string }[] = [
  { key: "active",             label: "SKU Manager" },
  { key: "misc_cost",          label: "Misc. Cost" },
  { key: "rm_vendor",          label: "Approved Vendor Rates" },
  { key: "agreed_rates",       label: "Agreed Mfg Rates" },
  { key: "final_costing",      label: "Agreed Final Costing" },
  { key: "analytics",          label: "Analytics" },
  { key: "common_rms",         label: "Common RMs" },
  { key: "vendor_ing_mapping", label: "Vendor Ing Mapping" },
]
```

---

## 2. `costing-columns.tsx` — lift the delta cells

The four helpers below are **moved verbatim** out of
`FinalCostingComparisonTable.tsx:15-29` and wrapped in one component. Append to
`app/manufacturing/[mfgId]/costing-columns.tsx`:

```tsx
import type { FinalCostingComparisonRow } from "@/types/masters"

function fmtPct(v: number) {
  const sign = v > 0 ? "+" : ""
  return `${sign}${v.toFixed(1)}%`
}

function fmtDelta(v: number) {
  const sign = v > 0 ? "+" : ""
  return `${sign}${fmtMoney(v)}`
}

function deltaClass(v: number) {
  if (v > 0) return "text-destructive"
  if (v < 0) return "text-emerald-600 dark:text-emerald-400"
  return ""
}

/**
 * The three Δ-vs-MRM cells, shared by the Analytics tab's comparison tables and
 * by the expanded row on Agreed Final Costing. Two copies of this drift; the
 * whole reason this file exists is that the header list and the cell list did.
 */
export function DeltaCells({ row }: { row: FinalCostingComparisonRow }) {
  return (
    <>
      <TableCell className={"text-right tabular-nums " + deltaClass(row.rm_delta)}>
        {fmtDelta(row.rm_delta)} ({fmtPct(row.rm_delta_pct)})
      </TableCell>
      <TableCell className={"text-right tabular-nums " + deltaClass(row.pm_delta)}>
        {fmtDelta(row.pm_delta)} ({fmtPct(row.pm_delta_pct)})
      </TableCell>
      <TableCell className={"text-right tabular-nums font-semibold " + deltaClass(row.total_delta)}>
        {fmtDelta(row.total_delta)} ({fmtPct(row.total_delta_pct)})
      </TableCell>
    </>
  )
}
```

Also fix the stale file header at `costing-columns.tsx:1-11` — the four tables no
longer sit on one page:

```
// The column set shared by the Agreed Final Costing table, the three vendor-rate
// comparisons on the Analytics tab, and the expanded per-SKU row that shows those
// three scenarios inline.
//
// It lives in one file because the columns must line up in all three places: the
// comparison tables are STACKED and read down a column, and the expanded row
// reads across the costing row it hangs under. That only works if a column sits
// at the same x-position everywhere — and it did not, because the MRM table
// declared its own 9 headers and the comparison table declared a different 9.
```

### `FinalCostingComparisonTable.tsx` — use it

- Delete `fmtPct` / `fmtDelta` / `deltaClass` (`:15-29`) and the now-unused
  `fmtMoney` import (`:10`).
- Add `DeltaCells` to the `./costing-columns` import (`:11-13`).
- Replace the three delta `<TableCell>`s at `:88-96` with `<DeltaCells row={r} />`.

Nothing else in that file changes.

---

## 3. `VendorCostingComparison.tsx` — reword three subtitles

The tables now live on their own tab, so "the agreed MRM rate **above**" points
at nothing. Three strings at `:28`, `:34`, `:42` — `above` → `on the Agreed Final
Costing tab`. Same for the doc comment at `:6-13`, which describes them as
sitting under the MRM table.

`FinalCostingComparisonTable.tsx:75-77` also says its empty state needs no action
"because this table always renders under FinalCostingTable, which already offers
the Add SKUs button". That is no longer true. Cheapest honest fix: the comment
goes, and the empty state stays actionless — an empty Analytics tab is reached
from a costing tab that already said the same thing.

---

## 4. `page.tsx` — route the new tab to the same loader

`app/manufacturing/[mfgId]/page.tsx:52-57`

```ts
const VALID_TABS: MfgTab[] = [
  "active",
  "misc_cost",
  "rm_vendor", "agreed_rates", "final_costing", "analytics",
  "common_rms", "vendor_ing_mapping",
]
```

`:109-118` — one branch serves both tabs, because both need the same eight
queries. Replace the `tab === "final_costing"` block with:

```tsx
{(tab === "final_costing" || tab === "analytics") && (
  // Both tabs run the same eight queries: the comparison rows are computed
  // against the MRM rows, and the expandable row on the costing tab shows the
  // comparisons. Splitting them into two loaders would duplicate all of it.
  //
  // The min/max vendor-rate comparison spans every vendor, so this needs the
  // vendor dimension of the scope too.
  <FinalCostingTabContent
    mfgId={id}
    view={tab}
    brandScope={scopeParams(scope.brandIds)}
    vendorScope={[...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]}
    approvedScope={[...scopeParams(scope.vendorIds), ...scopeParams(scope.vendorIds)]}
  />
)}
```

`:202-204` — signature gains `view`:

```ts
async function FinalCostingTabContent({
  mfgId, view, brandScope, vendorScope, approvedScope,
}: {
  mfgId: number
  view: "final_costing" | "analytics"
  brandScope: unknown[]; vendorScope: unknown[]; approvedScope: unknown[]
}) {
```

`:343-353` — the return splits. `SCENARIOS` is declared here because the labels
are needed by both the Analytics tables and the expanded row:

```tsx
  // Built in the same order in both branches, so the expanded row's scenario
  // arrays stay index-aligned with `rows` (each is `rows.map(...)`).
  const scenarios = [
    { label: "Approved vendor rate",           rows: buildComparisonRows("approved") },
    { label: "Cheapest available vendor rate", rows: buildComparisonRows("min") },
    { label: "Most expensive available rate",  rows: buildComparisonRows("max") },
  ]

  if (view === "analytics") {
    return (
      <VendorCostingComparison
        approvedRows={scenarios[0].rows}
        minRows={scenarios[1].rows}
        maxRows={scenarios[2].rows}
        exportEndpoint={`/api/v1/manufacturing/${mfgId}/final-costing/detailed-export`}
      />
    )
  }

  return <FinalCostingTable mfgId={mfgId} rows={rows} scenarios={scenarios} />
```

The outer `<div className="space-y-6">` goes — each branch renders one child.

The detailed export moves with the tables; it already hangs off the last
comparison table, so no route and no button changes.

---

## 5. `FinalCostingTable.tsx` — the expandable row

Single-open expansion, keyed on `recipe_id` — the same `useState<number | null>`
+ `toggle` shape as `app/po-tracking/invoices/InvoiceGroupTable.tsx:77,148`.

Imports:

```tsx
import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { FinalCostingRow, FinalCostingComparisonRow } from "@/types/masters"
import {
  CostingHeadRow, CostingCells, DeltaCells, ScenarioLabelRow, bestTotalIndex, COSTING_COL_COUNT,
} from "./costing-columns"
```

Signature and state:

```tsx
export default function FinalCostingTable({
  mfgId, rows, scenarios,
}: {
  mfgId: number
  rows: FinalCostingRow[]
  /** The Analytics tab's three scenarios, each array built as `rows.map(...)`
   *  and therefore index-aligned with `rows`. */
  scenarios: { label: string; rows: FinalCostingComparisonRow[] }[]
}) {
  const best = bestTotalIndex(rows)
  const [open, setOpen] = useState<number | null>(null)
```

The subtitle at `:42-44` gains one sentence, and the stale export comment at
`:45-47` (which says the detailed breakup "sits under them") is replaced:

```tsx
        <p className="text-[11px] text-muted-foreground">
          Total = RM + PM + (RM × RM Wastage%) + (PM × PM Wastage%) + JW + Shrink Wrap + Shipper. Rates from this manufacturer&apos;s agreed MRM rates. Click a SKU to compare it against the vendor rates.
        </p>
        {/* The vendor-rate comparisons and their detailed-breakup export live on
            the Analytics tab now; this button covers this table only. */}
```

The row body at `:74-98` becomes a fragment per SKU — one costing row, plus three
scenario rows when it is open:

```tsx
                  rows.map((r, i) => {
                    const isOpen = open === r.recipe_id
                    const toggle = () => setOpen(isOpen ? null : r.recipe_id)
                    return (
                      <Fragment key={r.recipe_id}>
                        <TableRow className={isOpen ? "bg-muted/40" : undefined}>
                          <TableCell className="font-mono">
                            <span className="inline-flex items-center gap-1">
                              {r.incomplete && (
                                <span
                                  title={incompleteReasons(r)}
                                  className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] font-bold cursor-help"
                                >
                                  !
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={toggle}
                                aria-expanded={isOpen}
                                className="inline-flex items-center gap-1 hover:underline"
                                title="Compare against approved / cheapest / priciest vendor rates"
                              >
                                {isOpen
                                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                  : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                                {r.sku_code ?? "—"}
                              </button>
                            </span>
                          </TableCell>
                          <TableCell
                            onClick={toggle}
                            className="max-w-40 cursor-pointer truncate text-muted-foreground hover:underline"
                          >
                            {r.sku_name ?? "—"}
                          </TableCell>
                          <CostingCells row={r} best={i === best} />
                          {/* This row IS the baseline the three scenarios measure
                              against, so its delta cells hold the alignment
                              rather than carrying a figure. */}
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right text-[11px] italic text-muted-foreground">baseline</TableCell>
                        </TableRow>
                        {isOpen && scenarios.map((s) => (
                          <TableRow key={s.label} className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={2} className="pl-6 text-[11px] text-muted-foreground">
                              {s.label}
                            </TableCell>
                            <CostingCells row={s.rows[i]} best={false} />
                            <DeltaCells row={s.rows[i]} />
                          </TableRow>
                        ))}
                      </Fragment>
                    )
                  })
```

`Fragment` comes from `react` (`import { Fragment, useState } from "react"`) —
the keyed wrapper is needed because each SKU now renders up to four rows.

`colSpan={2}` + 7 `CostingCells` + 3 `DeltaCells` = 12 = `COSTING_COL_COUNT`, so
the scenario rows line up under the costing row exactly.

---

## What this does not touch

- **No API, no SQL, no DB.** Both export routes
  (`final-costing/export`, `final-costing/detailed-export`) are unchanged; the
  detailed one simply renders on a different tab.
- **No new dependency.** `lucide-react` chevrons and `useState` are both already
  used on this page's siblings.
- **No permission row.** `?tab=` is a search param on `/manufacturing/[mfgId]`.

## Check to leave behind

`tests/unit/` can't render React, and everything moved here is presentational —
the one thing with logic that could silently break is the column count, which
the expanded row now depends on:

`tests/unit/costing-columns.test.ts` — assert `COSTING_COL_COUNT === 12`, i.e.
`2 (SKU + name) + 7 (CostingCells) + 3 (DeltaCells)`. If someone adds a header
without adding a cell, the expanded row shifts under the costing row and the
test fails instead.

## Deferred

- The MRM baseline is not repeated inside the Analytics tables — you read it on
  the costing tab, or in the expanded row. Add it as a fourth stacked table if
  people start flipping between tabs to get it.
- Multi-row expansion (several SKUs open at once). Single-open matches the
  invoice desk; add a `Set` if comparing two SKUs' scenarios side by side turns
  out to be the real need.
