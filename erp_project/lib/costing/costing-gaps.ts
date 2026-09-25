/**
 * Why a SKU × manufacturer pair can't be costed, named precisely.
 *
 * Shared by the Agreed Final Costing table (which sees the resulting zeros), the
 * SKUs tab (where someone actually fixes the line) and the invoice drilldown, so
 * they cannot drift into telling different stories about the same gap.
 *
 * Fill weight is a MULTIPLICAND in the RM formula ((amount × filling × rate) /
 * 100000), so a null there zeroes every RM line even when every agreed rate is
 * present — a different fix, by a different person, than a missing rate.
 *
 * ── Why this is in lib/ and not beside the page ──────────────────────────────
 * It began in app/manufacturing/[mfgId]/costing-gaps.ts, which is still the
 * import everything uses — that file re-exports this one. It moved down because
 * gift kit costing composes a COMPONENT's gaps inside lib/costing, and lib
 * importing from app would invert the dependency. Pure either way: no React, no
 * lib/db, so tests/unit can reach it.
 */

import type { MiscCostType } from "@/types/masters"
import { COST_TYPE_LABEL, REQUIRED_COST_TYPES, appliesToShape, type RecipeShape } from "./cost-types"

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

/**
 * Misc costs with no `bom_misc` row for this recipe × manufacturer. An absent
 * key and a genuine 0% are different states — only the absent ones are gaps,
 * and only for the types every line is expected to carry.
 *
 * `shape` decides what "expected" means. A gift kit has no raw material, so
 * `rm_loss` is not missing on one — it is INAPPLICABLE, and naming it would send
 * someone to set a percentage that can never apply. Declared in cost-types.ts,
 * read here.
 */
export function missingMiscReasons(
  misc: Partial<Record<MiscCostType, number>>,
  shape: RecipeShape = "formulation",
): string[] {
  const missing = REQUIRED_COST_TYPES
    .filter((t) => appliesToShape(t, shape))
    .filter((t) => misc[t] === undefined)
  return missing.length === 0
    ? []
    : [`No ${missing.map((t) => COST_TYPE_LABEL[t]).join(", ")} cost set for this manufacturer`]
}
