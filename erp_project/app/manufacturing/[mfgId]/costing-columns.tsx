// The column set shared by the Agreed Final Costing table, the three vendor-rate
// comparisons on the Analytics tab, and the expanded per-SKU row that shows those
// three scenarios inline.
//
// It lives in one file because the columns must line up in all three places: the
// comparison tables are STACKED and read down a column, and the expanded row
// reads across the costing row it hangs under. That only works if a column sits
// at the same x-position everywhere — and it did not, because the MRM table
// declared its own 9 headers and the comparison table declared a different 9.
// Two lists that had to agree and nothing making them.
//
// Everything about a column now lives on one line here: its label, its width,
// and how its cell renders. Add a column and every table gets it.

import { TableCell, TableHead, TableRow } from "@/components/ui/table"
// FinalCostingComparisonRow is no longer imported: nothing here reads a delta
// field. A scenario row is still one, but every cell this file renders comes
// from the FinalCostingRow half of it, which is what CostingCells takes.
import type { FinalCostingRow } from "@/types/masters"
import { fmtMoney } from "../mfg-utils"

/** Fixed widths, sized to the digits rather than to the label, so the four
 *  tables stay as narrow as the numbers allow. */
const W = {
  sku:     "w-[130px]",
  name:    "w-[168px]",
  money:   "w-[78px]",
  small:   "w-[72px]",
  total:   "w-[94px]",
  actions: "w-[84px]",
} as const

const HEADS: { label: string; width: string; numeric: boolean }[] = [
  { label: "SKU",           width: W.sku,   numeric: false },
  { label: "SKU Name",      width: W.name,  numeric: false },
  { label: "RM Cost",       width: W.money, numeric: true  },
  { label: "PM Cost",       width: W.money, numeric: true  },
  { label: "JWW",           width: W.small, numeric: true  },
  { label: "Shrinkage",     width: W.money, numeric: true  },
  { label: "Shipper",       width: W.small, numeric: true  },
  { label: "Wastage",       width: W.money, numeric: true  },
  { label: "Total Costing", width: W.total, numeric: true  },
]

export const COSTING_COL_COUNT = HEADS.length

/**
 * `actions` appends the trailing Actions column — Agreed Final Costing only.
 * The three Analytics comparison tables share HEADS and have no per-row control,
 * so making it a 10th HEADS entry would give all three a permanently empty
 * column. A table that passes this spans COSTING_COL_COUNT + 1.
 *
 * There are no Δ-vs-MRM columns any more, in any of the four tables. On Agreed
 * Final Costing they were always `—`, `—`, "baseline" — its own rows ARE the MRM
 * baseline, so there was nothing to measure against. On Analytics and in the
 * expanded scenario table they were real, but the baseline they measured from
 * was not beside them, so the arithmetic could not be checked where it was read.
 * Compare totals down the Total Costing column instead.
 */
export function CostingHeadRow({ actions = false }: { actions?: boolean } = {}) {
  const heads = actions
    ? [...HEADS, { label: "Actions", width: W.actions, numeric: false }]
    : HEADS
  return (
    <TableRow>
      {heads.map((h) => (
        <TableHead key={h.label} className={`${h.width} ${h.numeric ? "text-right" : ""}`}>
          {h.label}
        </TableHead>
      ))}
    </TableRow>
  )
}

/**
 * The costing heads for the scenario table inside an expanded row, whose first
 * column names the scenario rather than the SKU.
 *
 * Reuses HEADS from index 2 so the labels and their order cannot drift from the
 * parent table's — the whole reason this file exists is that a header list and a
 * cell list did exactly that.
 */
export function ScenarioHeadRow() {
  return (
    <TableRow>
      <TableHead className={W.name}>Scenario</TableHead>
      {HEADS.slice(2).map((h) => (
        <TableHead key={h.label} className={`${h.width} ${h.numeric ? "text-right" : ""}`}>
          {h.label}
        </TableHead>
      ))}
    </TableRow>
  )
}

/**
 * The scenario's name, as the first row of its own table body.
 *
 * The card heading above says the same thing, but scrolls away — and with four
 * near-identical tables stacked, "which one am I looking at" is the question
 * you ask precisely when the heading is off-screen.
 */
export function ScenarioLabelRow({
  label, colSpan = COSTING_COL_COUNT,
}: {
  label: string
  /**
   * Pass COSTING_COL_COUNT + 1 from a table that renders the Actions column. An
   * over-span is clamped silently by the browser, so getting this wrong looks
   * right — which is why the Actions table sets it rather than relying on the
   * default.
   */
  colSpan?: number
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className="bg-muted/50 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </TableCell>
    </TableRow>
  )
}

/**
 * RM through Total, identical in every table.
 *
 * `best` tints the total of the cheapest SKU in this scenario. The inputs are
 * muted and the total is not: the total is the figure being compared, the rest
 * are how it was arrived at, and rendering all eight at one weight left nothing
 * for the eye to land on.
 */
export function CostingCells({ row, best }: { row: FinalCostingRow; best: boolean }) {
  const input = "text-right tabular-nums text-muted-foreground"
  return (
    <>
      <TableCell className={input}>{fmtMoney(row.rm_cost)}</TableCell>
      <TableCell className={input}>{fmtMoney(row.pm_cost)}</TableCell>
      <TableCell className={input}>{fmtMoney(row.jw)}</TableCell>
      <TableCell className={input}>{fmtMoney(row.shrink)}</TableCell>
      <TableCell className={input}>{fmtMoney(row.shipper)}</TableCell>
      <TableCell className={input}>{fmtMoney(row.wastage)}</TableCell>
      <TableCell
        className={
          "text-right tabular-nums font-semibold " +
          (best ? "text-emerald-600 dark:text-emerald-400" : "")
        }
        title={best ? "Lowest total costing in this scenario" : undefined}
      >
        {fmtMoney(row.total)}
      </TableCell>
    </>
  )
}

/** Index of the row with the lowest total, or -1 when nothing is costed yet.
 *  Zero totals are skipped — an unpriced SKU is not the cheapest one. */
export function bestTotalIndex(rows: FinalCostingRow[]): number {
  let best = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].total <= 0) continue
    if (best === -1 || rows[i].total < rows[best].total) best = i
  }
  return best
}
