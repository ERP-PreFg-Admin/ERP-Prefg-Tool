/**
 * Gift kit costing — the roll-up, and the rule for which manufacturer prices a
 * component.
 *
 * A gift kit is assembled from finished goods, not made from raw material
 * (lib/masters/kit-sku.ts). Its recipe carries `mtrl_type = 'sku'` lines whose
 * `mtrl_id` is a component's `master_skus.id` and whose `amount` is a UNIT
 * COUNT. The two sibling costing queries drop those lines, so a kit used to read
 * RM ₹0 — and, because rateGapReasons only explains an RM gap when
 * `rm_line_count > 0`, it read ₹0 with no reason attached, which is
 * indistinguishable from a SKU whose RM genuinely is zero.
 *
 * What rolls up is the component's FULL final cost — the same number its own
 * Agreed Final Costing row shows — because the assembler receives a finished
 * good, not a bag of ingredients.
 *
 * Pure module: no React, no lib/db, so tests/unit can reach it. The database
 * half lives in lib/costing/agreed-rates.ts.
 */

import type { MiscCostType } from "@/types/masters"
import { computeTotalCosting, computeWastage } from "./final-costing"
import { appliesToShape } from "./cost-types"

/** One manufacturer that could price a component, and what it costs there. */
export type ComponentCandidate = {
  mfgId: number
  /** null when this manufacturer has no costing for the component. */
  rate: number | null
  /** The component's OWN costing gaps, if any — decision 2. */
  gaps: readonly string[]
}

export type KitComponentInput = {
  skuCode: string
  skuName: string | null
  /** The `amount` on the 'sku' line — how many of this component the kit holds. */
  units: number
  candidates: readonly ComponentCandidate[]
}

export type ResolvedKitComponent = {
  skuCode: string
  skuName: string | null
  units: number
  /** The manufacturer chosen to price it, or null when none can. */
  mfgId: number | null
  /** Cost of ONE unit. null = uncostable. */
  unitCost: number | null
  /** unitCost × units. null = uncostable. */
  lineCost: number | null
  gaps: readonly string[]
  /**
   * True when more than one manufacturer could have priced it and the kit's own
   * was not among them, so the pick was made on price alone.
   */
  ambiguous: boolean
}

/**
 * Which manufacturer prices this component.
 *
 * 1. The kit's own manufacturer, when it is one of the candidates AND has a
 *    costing. The assembler's own cost for a thing it also makes beats an
 *    outside quote.
 * 2. Otherwise the only candidate that has a costing.
 * 3. Otherwise the cheapest — flagged `ambiguous`, because the number was chosen
 *    on price rather than on who actually supplies this kit, and nobody should
 *    negotiate off that without being told.
 *
 * Candidates with no costing never win: a missing cost is not a cheap one.
 */
export function resolveComponent(
  input: KitComponentInput,
  kitMfgId: number,
): ResolvedKitComponent {
  const base = { skuCode: input.skuCode, skuName: input.skuName, units: input.units }
  const priced = input.candidates.filter((c) => c.rate != null)

  const own = priced.find((c) => c.mfgId === kitMfgId)
  const chosen = own ?? (priced.length === 1
    ? priced[0]
    : priced.length > 1
      ? priced.reduce((a, b) => (b.rate! < a.rate! ? b : a))
      : null)

  if (!chosen) {
    return {
      ...base, mfgId: null, unitCost: null, lineCost: null,
      // A component with no priced candidate still carries whatever its own
      // recipe could say — an unrated line is more useful than "no costing".
      gaps: input.candidates.flatMap((c) => c.gaps),
      ambiguous: false,
    }
  }

  return {
    ...base,
    mfgId: chosen.mfgId,
    unitCost: chosen.rate,
    lineCost: chosen.rate! * input.units,
    gaps: chosen.gaps,
    ambiguous: !own && priced.length > 1,
  }
}

export type KitCosting = {
  components: readonly ResolvedKitComponent[]
  /** The roll-up — what lands in the kit's RM column. Excludes uncostable components. */
  componentCost: number
  costedComponents: number
  totalComponents: number
  /** True when at least one component could not be priced at all. */
  partial: boolean
}

/** Roll the resolved components into the kit's material figure. */
export function rollUpComponents(components: readonly ResolvedKitComponent[]): KitCosting {
  const costed = components.filter((c) => c.lineCost != null)
  return {
    components,
    componentCost: costed.reduce((sum, c) => sum + c.lineCost!, 0),
    costedComponents: costed.length,
    totalComponents: components.length,
    partial: costed.length < components.length,
  }
}

/**
 * Why a kit's cost is not the whole story, in the same voice rateGapReasons uses
 * — every screen words a gap the same way or people stop trusting all of them.
 *
 * Three things can be wrong, and they need different people to fix:
 *   - a component nobody can price yet (masters work)
 *   - a component priced off its own incomplete recipe (that component's rates)
 *   - a component priced on cheapness alone (procurement should say who supplies it)
 */
export function kitGapReasons(kit: KitCosting): string[] {
  const reasons: string[] = []

  const uncosted = kit.totalComponents - kit.costedComponents
  if (uncosted > 0) {
    reasons.push(
      `${uncosted} of ${kit.totalComponents} component${kit.totalComponents === 1 ? "" : "s"} ` +
      `ha${uncosted === 1 ? "s" : "ve"} no costed recipe — the kit total is missing them`
    )
  }

  for (const c of kit.components) {
    if (c.lineCost != null && c.gaps.length > 0) {
      reasons.push(`Component ${c.skuCode} is costed from an incomplete recipe: ${c.gaps.join("; ")}`)
    }
    if (c.ambiguous) {
      reasons.push(
        `Component ${c.skuCode} is made at several manufacturers, none of them this one — ` +
        `priced at the cheapest`
      )
    }
  }
  return reasons
}

/**
 * A kit's total.
 *
 * `rm_loss` does NOT apply: a kit has no raw material to lose. `pm_loss` does —
 * its box and sleeve can still be damaged. That asymmetry is declared once, in
 * lib/costing/cost-types.ts `appliesTo`, and read here rather than hardcoded, so
 * the next shape with its own rules is a table entry.
 *
 * Everything else routes through computeTotalCosting, so a kit and a formulation
 * cannot drift into two different definitions of "total".
 */
export function computeKitTotal(params: {
  /** The roll-up from rollUpComponents — lands in the RM position. */
  componentCost: number
  /** The kit's OWN packaging: the box, the sleeve. Its `pm` recipe lines. */
  pmCost: number
  misc: Record<MiscCostType, number>
}): { total: number; wastageTotal: number } {
  const { componentCost, pmCost, misc } = params

  // Zeroing the rm side rather than skipping computeWastage keeps one wastage
  // implementation. appliesToShape is the declaration, not this call site.
  const rmLossPct = appliesToShape("rm_loss", "kit") ? misc.rm_loss : 0
  const pmLossPct = appliesToShape("pm_loss", "kit") ? misc.pm_loss : 0
  const { total: wastageTotal } = computeWastage(componentCost, pmCost, rmLossPct, pmLossPct)

  return {
    wastageTotal,
    total: computeTotalCosting({
      rmCost: componentCost, pmCost, wastageTotal,
      jw: misc.jw, shrink: misc.shrink, shipper: misc.shipper,
      utility: misc.utility, margin: misc.margin,
    }),
  }
}
