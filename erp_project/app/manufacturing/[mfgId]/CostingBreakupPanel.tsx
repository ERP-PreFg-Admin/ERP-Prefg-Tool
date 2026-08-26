/**
 * What the Agreed Final Costing Actions column opens: the RM/PM lines behind a
 * SKU's RM Cost and PM Cost cells, plus its misc costs.
 *
 * Two structural choices carry the meaning here:
 *
 *  - the lines are GROUPED by RM/PM with a subtotal each, rather than carrying a
 *    "Type" column repeated on every row. The subtotals are the RM Cost and PM
 *    Cost cells of the row this opened from, so the panel can be checked against
 *    it instead of merely sitting under it.
 *  - a line with no agreed rate tints its whole row, because a ₹0 cost in one
 *    cell is exactly what someone opens this panel to find and a single amber
 *    word does not survive a scan of twenty lines.
 *
 * Presentational and stateless, so no "use client" — it renders inside
 * FinalCostingTable's expanded row with the breakup the page already built.
 */

import { wastageFraction } from "@/lib/costing/final-costing"
import type { BreakupLine, CostingBreakup } from "./costing-breakup"
import { fmtMoney } from "../mfg-utils"

/** A gap, not a zero — telling those apart is the whole job of the panel. */
const NOT_SET = <span className="text-amber-700 dark:text-amber-400">not set</span>

const AMBER = "text-amber-700 dark:text-amber-400"

function GroupHeadRow({ label }: { label: string }) {
  return (
    <tr>
      <th
        colSpan={5}
        className="bg-muted/60 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </th>
    </tr>
  )
}

function LineRows({ lines, label, total }: { lines: BreakupLine[]; label: string; total: number }) {
  if (lines.length === 0) return null
  return (
    <>
      <GroupHeadRow label={label} />
      {lines.map((l, i) => {
        const unpriced = l.rate == null
        return (
          <tr
            key={`${l.code}-${i}`}
            className={unpriced ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}
          >
            <td className="px-2 py-1 font-mono">{l.code ?? "—"}</td>
            <td className="max-w-56 truncate px-2 py-1 text-muted-foreground" title={l.name ?? undefined}>
              {l.name ?? "—"}
            </td>
            {/* Raw, not money: an RM amount is a formulation percentage of fill
                weight and a PM amount is a unit count. Neither is rupees. */}
            <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{l.amount}</td>
            <td className="px-2 py-1 text-right tabular-nums">{unpriced ? NOT_SET : fmtMoney(l.rate)}</td>
            <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtMoney(l.cost)}</td>
          </tr>
        )
      })}
      <tr className="border-t border-border">
        <td colSpan={4} className="px-2 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
          {label} total
        </td>
        <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtMoney(total)}</td>
      </tr>
    </>
  )
}

export default function CostingBreakupPanel({ breakup }: { breakup: CostingBreakup }) {
  const rmLines = breakup.lines.filter((l) => l.type === "rm")
  const pmLines = breakup.lines.filter((l) => l.type === "pm")

  return (
    // A contained surface: the expanded row is already bg-muted/40, so without
    // this the panel bleeds into the table it is nested in.
    <div className="rounded-lg border bg-card p-3">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Recipe lines at agreed rates
            </h4>
            {breakup.unpricedLines > 0 && (
              <span className={`shrink-0 text-[11px] ${AMBER}`}>
                {breakup.unpricedLines} line{breakup.unpricedLines === 1 ? "" : "s"} with no agreed rate
              </span>
            )}
          </div>
          {/* A plain table, not the shared primitives: this is nested inside a
              table cell and must not inherit the outer table's fixed layout. */}
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="w-24 px-2 pb-1 text-left font-medium">Code</th>
                <th className="px-2 pb-1 text-left font-medium">Material</th>
                <th className="w-14 px-2 pb-1 text-right font-medium">Qty</th>
                <th className="w-20 px-2 pb-1 text-right font-medium">Rate</th>
                <th className="w-20 px-2 pb-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {breakup.lines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2 py-2 text-muted-foreground">
                    This recipe has no active lines.
                  </td>
                </tr>
              ) : (
                <>
                  <LineRows lines={rmLines} label="Raw material" total={breakup.rmTotal} />
                  <LineRows lines={pmLines} label="Packing material" total={breakup.pmTotal} />
                </>
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Misc. costs
          </h4>
          <table className="w-full border-collapse">
            <tbody>
              {breakup.misc.map((m) => (
                <tr key={m.type} className="border-b border-border/50 last:border-0">
                  <td className="py-1 text-muted-foreground">{m.label}</td>
                  <td className="py-1 text-right tabular-nums">
                    {/* Wastage is a percentage — through wastageFraction, because
                        the stored value is in one of two units and this must read
                        it the same way the costing does. The rest are money. */}
                    {m.value == null ? NOT_SET
                      : m.type === "rm_loss" || m.type === "pm_loss"
                        ? `${(wastageFraction(m.value) * 100).toFixed(2)}%`
                        : fmtMoney(m.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
