/**
 * Costing gap wording and the misc-cost labels, for the manufacturing screens.
 *
 * The gap functions themselves moved to lib/costing/costing-gaps.ts so that gift
 * kit costing can compose a COMPONENT's gaps inside lib/ without app/ and lib/
 * importing each other. This file stays the import path every screen already
 * uses — FinalCostingTable, the [mfgId] page, the breakup panel and the invoice
 * drilldown all point here.
 */

import type { MiscCostType } from "@/types/masters"
import { COST_TYPE_LABEL, OPTIONAL_COST_TYPES } from "@/lib/costing/cost-types"

export { rateGapReasons, missingMiscReasons, type CostingGapInput } from "@/lib/costing/costing-gaps"

/**
 * Also the label and the display ORDER for the breakup panel's misc list.
 *
 * Derived from lib/costing/cost-types.ts, whose key order IS this order —
 * declare a new cost type, or reorder the panel, there.
 */
export const MISC_LABEL: Record<MiscCostType, string> = COST_TYPE_LABEL

/**
 * Misc costs that only some arrangements carry, so their absence is not a gap.
 *
 * Utility and Margin are charged by some manufacturers and not others — unlike
 * JW, shrink, shipper and the two wastage percentages, which every costed line
 * is expected to declare even when the answer is 0. Warning about them turned
 * every SKU amber the day they were added, which trains people to ignore the
 * warning that does mean something.
 *
 * They still price normally when present: computeTotalCosting adds both, and
 * ZERO_MISC covers the absent case.
 */
export const OPTIONAL_MISC: readonly MiscCostType[] = OPTIONAL_COST_TYPES
