/**
 * One SKU's costing, decomposed — what the Agreed Final Costing Actions column
 * opens.
 *
 * The table's RM Cost cell is a SUM; these are the addends. It re-uses the same
 * computeRmCost/computePmCost the aggregate SQL applies, so the lines add up to
 * the row above them — which only holds because selectBomLineDetailByMfg
 * resolves `filling` the same way selectMaterialCostByMfg does.
 *
 * Pure, so it is unit-tested. The route/page only groups rows and calls this.
 */

import type { MiscCostType } from "@/types/masters"
import { computeRmCost, computePmCost } from "@/lib/costing/final-costing"
import { MISC_LABEL } from "./costing-gaps"

export type BreakupLine = {
  type: "rm" | "pm"
  code: string | null
  name: string | null
  /** RM: a formulation % of the SKU's fill weight. PM: a per-unit quantity. Not money. */
  amount: number
  /** null = no agreed rate for this manufacturer. NOT a rate of zero. */
  rate: number | null
  cost: number
}

/** A null value = no `bom_misc` row at all, which is not the same as 0. */
export type BreakupMisc = { type: MiscCostType; label: string; value: number | null }

export type CostingBreakup = {
  lines: BreakupLine[]
  misc: BreakupMisc[]
  /** Lines with no agreed rate — the "if any one is missing" headline. */
  unpricedLines: number
  /** Sum of the RM lines — the row's RM Cost cell, from its addends. Shown as a
   *  subtotal so the panel can be checked against the row it opened from; an
   *  unpriced line contributes 0, which is why the gap count sits beside it. */
  rmTotal: number
  /** Sum of the PM lines — the row's PM Cost cell. */
  pmTotal: number
}

/** The columns of selectBomLineDetailByMfg this needs, as mysql2 returns them. */
export type BreakupLineInput = {
  mtrl_type: "rm" | "pm"
  amount: string
  filling: string | null
  mtrl_code: string | null
  mtrl_name: string | null
  mrm_rate: string | null
}

export function buildBreakup(
  lines: BreakupLineInput[],
  misc: Partial<Record<MiscCostType, number>>,
): CostingBreakup {
  const built: BreakupLine[] = lines.map((l) => {
    const amount = Number(l.amount)
    const rate = l.mrm_rate == null ? null : Number(l.mrm_rate)
    const filling = Number(l.filling ?? 0)
    return {
      type: l.mtrl_type,
      code: l.mtrl_code,
      name: l.mtrl_name,
      amount,
      rate,
      // An unpriced line costs 0, but it is shown as "not set" rather than ₹0 —
      // the caller reads `rate === null`, never a zero cost, to know that.
      cost: rate == null ? 0
        : l.mtrl_type === "rm" ? computeRmCost(filling, amount, rate)
        : computePmCost(amount, rate),
    }
  })

  // RM before PM, and inside each: unpriced lines first, then dearest first.
  // Sorting by cost alone buries an unpriced line at the bottom on its ₹0 cost —
  // the one line someone opened this panel to find.
  built.sort((a, b) =>
    a.type === b.type
      ? (a.rate == null ? 0 : 1) - (b.rate == null ? 0 : 1) || b.cost - a.cost
      : a.type === "rm" ? -1 : 1
  )

  const subtotal = (type: "rm" | "pm") =>
    built.reduce((sum, l) => (l.type === type ? sum + l.cost : sum), 0)

  return {
    lines: built,
    misc: (Object.keys(MISC_LABEL) as MiscCostType[]).map((type) => ({
      type, label: MISC_LABEL[type], value: misc[type] ?? null,
    })),
    unpricedLines: built.filter((l) => l.rate == null).length,
    rmTotal: subtotal("rm"),
    pmTotal: subtotal("pm"),
  }
}
