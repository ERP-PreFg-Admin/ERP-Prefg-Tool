/**
 * The one declaration of what a misc cost type IS.
 *
 * Before this table, four facts about a single cost type lived in four modules
 * that had to agree: its label and display order (MISC_LABEL), whether its
 * absence is a gap (OPTIONAL_MISC), whether it is money or a percentage
 * (MISC_ABSOLUTE), and the all-zero literal (ZERO_MISC) — plus two hand-written
 * lists inside computeTotalCosting and isIncompleteCosting. ZERO_MISC's own
 * comment records what that cost: "two callers kept their own copy of this
 * literal, so adding a cost type meant finding both. A missed one reads as a
 * genuine zero."
 *
 * Everything named above is now derived from this table. Adding a cost type is
 * one entry here; the derived constants and both lists follow.
 *
 * Pure module: no React, no lib/db, so tests/unit can reach it.
 */

import type { MiscCostType } from "@/types/masters"

/**
 * The recipe shapes a cost can apply to.
 *
 * A formulation is made from raw material. A kit is assembled from finished
 * goods — see lib/masters/kit-sku.ts — and has no raw material at all.
 */
export type RecipeShape = "formulation" | "kit"

/**
 * How the stored number becomes money.
 *
 * `absolute` is added straight to the total. The two percentages are run
 * through computeWastage against the cost they erode, which is why they name
 * their base: a percentage applied to the wrong subtotal is still a number, and
 * nothing downstream would question it.
 */
export type CostBasis = "absolute" | "percent_of_rm" | "percent_of_pm"

export type CostTypeSpec = {
  /** Shown in the breakup panel and named in gap messages. */
  label: string
  basis: CostBasis
  /**
   * Which recipe shapes this cost can exist on.
   *
   * NOT read by anything yet — the kit costing work consumes it. It is declared
   * now because it is the fact that forced this table: for a kit, `rm_loss` is
   * neither required nor optional, it is INAPPLICABLE, and the required/optional
   * boolean has no room for a third state. Until a consumer reads it, kits still
   * behave exactly as they did.
   */
  appliesTo: readonly RecipeShape[]
  /**
   * Is a missing row a gap? `false` means some manufacturers simply do not
   * charge it, so its absence says nothing — see OPTIONAL_MISC's history below.
   */
  required: boolean
}

const BOTH = ["formulation", "kit"] as const

/**
 * KEY ORDER IS THE DISPLAY ORDER of the breakup panel's misc list — it reads
 * `Object.keys(MISC_LABEL)`. Reordering this object reorders that panel.
 */
export const COST_TYPES: Record<MiscCostType, CostTypeSpec> = {
  jw:      { label: "JW",            basis: "absolute",      appliesTo: BOTH,              required: true },
  shrink:  { label: "Shrink Wrap",   basis: "absolute",      appliesTo: BOTH,              required: true },
  shipper: { label: "Shipper",       basis: "absolute",      appliesTo: BOTH,              required: true },
  // Utility and Margin are charged by some manufacturers and not others. Warning
  // about them turned every SKU amber the day they were added, which trains
  // people to ignore the warning that does mean something.
  utility: { label: "Utility",       basis: "absolute",      appliesTo: BOTH,              required: false },
  // Flat money on top, NOT a percentage of the cost. Reading it as a percentage
  // would silently divide it by 100.
  margin:  { label: "Margin",        basis: "absolute",      appliesTo: BOTH,              required: false },
  // A kit is assembled from finished goods and has no raw material to lose.
  rm_loss: { label: "RM Wastage %",  basis: "percent_of_rm", appliesTo: ["formulation"],   required: true },
  // Its box and sleeve can still be damaged, so PM wastage applies to both.
  pm_loss: { label: "PM Wastage %",  basis: "percent_of_pm", appliesTo: BOTH,              required: true },
}

/** Typed `Object.keys`, in declaration order. */
export const COST_TYPE_KEYS = Object.keys(COST_TYPES) as MiscCostType[]

const keysWhere = (p: (s: CostTypeSpec) => boolean): readonly MiscCostType[] =>
  COST_TYPE_KEYS.filter((t) => p(COST_TYPES[t]))

/** Label by type, in display order. */
export const COST_TYPE_LABEL: Record<MiscCostType, string> =
  Object.fromEntries(COST_TYPE_KEYS.map((t) => [t, COST_TYPES[t].label])) as Record<MiscCostType, string>

/** Absolute money, added straight to the total — as opposed to the percentages. */
export const ABSOLUTE_COST_TYPES = keysWhere((s) => s.basis === "absolute")

/** Types whose absence is not a gap. */
export const OPTIONAL_COST_TYPES = keysWhere((s) => !s.required)

/** Types every costed line is expected to declare, even when the answer is 0. */
export const REQUIRED_COST_TYPES = keysWhere((s) => s.required)

/**
 * Every misc cost at zero — the starting point for "this recipe has no bom_misc
 * rows". Derived, so it can no longer fall behind the type list.
 */
export const ZERO_COST_TYPES: Record<MiscCostType, number> =
  Object.fromEntries(COST_TYPE_KEYS.map((t) => [t, 0])) as Record<MiscCostType, number>

/** Does this cost type exist on this recipe shape at all? */
export function appliesToShape(type: MiscCostType, shape: RecipeShape): boolean {
  return COST_TYPES[type].appliesTo.includes(shape)
}
