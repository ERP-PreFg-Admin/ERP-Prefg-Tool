// The column set shared by all four Agreed Final Costing tables.
//
// It lives in one file because the tables are STACKED and read down a column:
// the agreed (MRM) costing, then the same recipe costed at the approved
// vendor's, cheapest and priciest rates. That only works if a column sits at
// the same x-position in every table — and it did not, because the MRM table
// declared its own 9 headers and the comparison table declared a different 9.
// Two lists that had to agree and nothing making them.
//
// Everything about a column now lives on one line here: its label, its width,
// and how its cell renders. Add a column and all four tables get it.

import { TableCell, TableHead, TableRow } from "@/components/ui/table"
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
  delta:   "w-[116px]",
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
  { label: "RM Δ vs MRM",   width: W.delta, numeric: true  },
  { label: "PM Δ vs MRM",   width: W.delta, numeric: true  },
  { label: "Total Δ vs MRM", width: W.delta, numeric: true },
]

export const COSTING_COL_COUNT = HEADS.length

export function CostingHeadRow() {
  return (
    <TableRow>
      {HEADS.map((h) => (
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
export function ScenarioLabelRow({ label }: { label: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={COSTING_COL_COUNT}
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
