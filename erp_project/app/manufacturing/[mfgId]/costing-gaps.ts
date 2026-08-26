/**
 * Why a SKU × manufacturer pair can't be costed, named precisely.
 *
 * Shared by the Agreed Final Costing table (which sees the resulting zeros) and
 * the SKUs tab (which is where someone actually fixes the line) so the two can't
 * drift into telling different stories about the same gap.
 *
 * Fill weight is a MULTIPLICAND in the RM formula ((amount × filling × rate) /
 * 100000), so a null there zeroes every RM line even when every agreed rate is
 * present — a different fix, by a different person, than a missing rate.
 */

import type { MiscCostType } from "@/types/masters"

export type CostingGapInput = {
  filling: number | null
  rm_line_count: number
  rm_lines_without_rate: number
  pm_lines_without_rate: number
}

export function rateGapReasons(g: CostingGapInput): string[] {
  const reasons: string[] = []

  if (!g.filling && g.rm_line_count > 0) {
    reasons.push("SKU has no fill weight — every RM line reads 0 until it is set")
  }
  if (g.rm_lines_without_rate > 0) {
    reasons.push(
      `${g.rm_lines_without_rate} of ${g.rm_line_count} RM line${g.rm_line_count === 1 ? " has" : "s have"} no agreed rate for this manufacturer`
    )
  }
  if (g.pm_lines_without_rate > 0) {
    reasons.push(`${g.pm_lines_without_rate} PM line(s) have no agreed rate for this manufacturer`)
  }
  return reasons
}

/** Also the label and the display ORDER for the breakup panel's misc list. */
export const MISC_LABEL: Record<MiscCostType, string> = {
  jw: "JW",
  shrink: "Shrink Wrap",
  shipper: "Shipper",
  rm_loss: "RM Wastage %",
  pm_loss: "PM Wastage %",
}

/**
 * Misc costs with no `bom_misc` row for this recipe × manufacturer. An absent
 * key and a genuine 0% are different states — only the absent ones are gaps.
 */
export function missingMiscReasons(misc: Partial<Record<MiscCostType, number>>): string[] {
  const missing = (Object.keys(MISC_LABEL) as MiscCostType[]).filter((t) => misc[t] === undefined)
  return missing.length === 0 ? [] : [`No ${missing.map((t) => MISC_LABEL[t]).join(", ")} cost set for this manufacturer`]
}
