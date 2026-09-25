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
  /**
   * `component` is a GIFT KIT's contents — a finished good, not a material.
   * Deliberately its own type rather than folded into `rm`: it occupies the RM
   * position in the costing, but calling a finished good "Raw material" in the
   * panel would be a lie, and its `rate` is that SKU's whole final cost rather
   * than a per-kg or per-unit material rate.
   */
  type: "rm" | "pm" | "component"
  code: string | null
  name: string | null
  /** RM: a formulation % of the SKU's fill weight. PM: a per-unit quantity. Component: a unit count. Not money. */
  amount: number
  /** null = no agreed rate for this manufacturer. NOT a rate of zero. */
  rate: number | null
  cost: number
}

/** One resolved gift kit component, as lib/costing/kit-costing.ts returns it. */
export type BreakupComponentInput = {
  skuCode: string
  skuName: string | null
  units: number
  /** The component's full final cost at its resolved manufacturer. null = uncostable. */
  unitCost: number | null
  lineCost: number | null
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
  /**
   * A gift kit's contents. They arrive here rather than through `lines` because
   * selectBomLineDetailByMfg deliberately excludes `mtrl_type='sku'` — a
   * component's `mtrl_id` is a master_skus.id, and that query's consumers would
   * look it up in a PM rate map. See its comment; the filter stays.
   */
  components: readonly BreakupComponentInput[] = [],
): CostingBreakup {
  const componentLines: BreakupLine[] = components.map((c) => ({
    type: "component",
    code: c.skuCode,
    name: c.skuName,
    amount: c.units,
    rate: c.unitCost,
    cost: c.lineCost ?? 0,
  }))

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

  // Components, then RM, then PM; inside each: unpriced lines first, then
  // dearest first. Sorting by cost alone buries an unpriced line at the bottom on
  // its ₹0 cost — the one line someone opened this panel to find.
  const ORDER = { component: 0, rm: 1, pm: 2 } as const
  const all = [...componentLines, ...built]
  all.sort((a, b) =>
    a.type === b.type
      ? (a.rate == null ? 0 : 1) - (b.rate == null ? 0 : 1) || b.cost - a.cost
      : ORDER[a.type] - ORDER[b.type]
  )

  const subtotal = (type: BreakupLine["type"]) =>
    all.reduce((sum, l) => (l.type === type ? sum + l.cost : sum), 0)

  // A kit has no RM lines, so its RM position holds the component roll-up —
  // the same number the row above the panel shows in its RM Cost cell.
  const componentTotal = subtotal("component")

  return {
    lines: all,
    misc: (Object.keys(MISC_LABEL) as MiscCostType[]).map((type) => ({
      type, label: MISC_LABEL[type], value: misc[type] ?? null,
    })),
    unpricedLines: all.filter((l) => l.rate == null).length,
    rmTotal: componentLines.length > 0 ? componentTotal : subtotal("rm"),
    pmTotal: subtotal("pm"),
  }
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * The open breakup panel as a CSV, built client-side from the data already
 * rendered — no route, because the page holds every breakup already.
 *
 * NOT lib/export.ts's buildCsv: that module imports ExcelJS at module scope and
 * its header says it is the only file allowed to, so importing it from a client
 * component would bundle ExcelJS into the browser. This mirrors
 * buildRecipeDumpCsv instead, BOM included so Excel on Windows reads it as UTF-8.
 *
 * Every row repeats the SKU, so a file stays readable once it is sorted or
 * filtered in Excel, and several exports can be pasted into one sheet.
 */
const BREAKUP_CSV_HEADER = [
  "SKU Code", "SKU Name", "Section", "Code", "Material", "Qty", "Rate", "Value", "Unit",
] as const

const csvCell = (v: unknown) =>
  v == null ? '""' : `"${String(v).replace(/"/g, '""')}"`

export function buildBreakupCsv(
  breakup: CostingBreakup,
  sku: { sku_code: string | null; sku_name: string | null },
  /** Stored wastage is in one of two units; the caller passes the same reader
   *  the costing uses so the file cannot disagree with the panel. */
  wastagePercent: (value: number) => number,
): string {
  const id = [sku.sku_code, sku.sku_name]
  const rows: unknown[][] = []

  const SECTION = {
    component: "Kit component",
    rm: "Raw material",
    pm: "Packing material",
  } as const

  for (const type of ["component", "rm", "pm"] as const) {
    const lines = breakup.lines.filter((l) => l.type === type)
    // Only the component section is conditional: a formulation has none, and a
    // bare "Kit component total: 0" row would read as a real zero. The RM and PM
    // sections keep emitting their totals exactly as before, empty or not.
    if (type === "component" && lines.length === 0) continue
    const label = SECTION[type]
    for (const l of lines) {
      rows.push([
        ...id, label, l.code, l.name, l.amount,
        // Blank, never 0 — an unpriced line is a gap, and the panel says "not
        // set" for exactly this reason. A zero here would read as a free input.
        l.rate == null ? "" : l.rate,
        l.rate == null ? "" : l.cost,
        l.rate == null ? "no agreed rate" : "INR",
      ])
    }
    rows.push([...id, `${label} total`, "", "", "", "", type === "pm" ? breakup.pmTotal : breakup.rmTotal, "INR"])
  }

  for (const m of breakup.misc) {
    const isPct = m.type === "rm_loss" || m.type === "pm_loss"
    rows.push([
      ...id, "Misc. cost", "", m.label, "", "",
      m.value == null ? "" : isPct ? wastagePercent(m.value) : m.value,
      m.value == null ? "not set" : isPct ? "%" : "INR",
    ])
  }

  return "\ufeff" + [BREAKUP_CSV_HEADER, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")
}
