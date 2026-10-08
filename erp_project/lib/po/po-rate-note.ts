// What price a PO line gets from agreed costing, and the note the bulk-upload
// preview shows for it. Pure, so preview, staging and approval cannot disagree.

import { poTotal, specialPoPrice, isSpecialPoType, SPECIAL_PO_LABEL, type PoPrice } from "./po-rules"

export type RateStatus = "priced" | "partial" | "unmapped" | "zero" | "special"

export type AgreedRateInput = {
  rate: number
  rm_lines_without_rate: number
  pm_lines_without_rate: number
}

export type RateVerdict = PoPrice & {
  status: RateStatus
  /** The SKU has a recipe at this manufacturer. */
  mapped: boolean
  /** Set when status is "special". */
  poType?: string
  rmMissing: number
  pmMissing: number
}

/** `agreed` undefined = the SKU has no recipe at this manufacturer. A special
 *  po_type is priced 0 whatever the costing says. */
export function classifyRate(agreed: AgreedRateInput | undefined, qty: number, gstPercent: unknown, poType?: string): RateVerdict {
  const rmMissing = Number(agreed?.rm_lines_without_rate ?? 0)
  const pmMissing = Number(agreed?.pm_lines_without_rate ?? 0)
  const mapped = !!agreed
  if (isSpecialPoType(poType)) return { ...specialPoPrice(), status: "special", mapped, poType, rmMissing: 0, pmMissing: 0 }
  if (!agreed) return { ...poTotal(null, qty, gstPercent), status: "unmapped", mapped, rmMissing: 0, pmMissing: 0 }
  if (!(agreed.rate > 0)) return { ...poTotal(null, qty, gstPercent), status: "zero", mapped, rmMissing, pmMissing }
  return {
    ...poTotal(agreed.rate, qty, gstPercent),
    status: rmMissing + pmMissing > 0 ? "partial" : "priced",
    mapped,
    rmMissing,
    pmMissing,
  }
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function rateNote(v: RateVerdict, qty: number, mfgCode: string): string {
  const priced = () =>
    `${inr(v.unitPrice!)} × ${qty.toLocaleString("en-IN")} + ${v.gstPercent}% GST = ${inr(v.totalAmount!)}`
  switch (v.status) {
    case "special": {
      const label = isSpecialPoType(v.poType) ? SPECIAL_PO_LABEL[v.poType] : "Special"
      return `${label} — price 0, pricing to be confirmed${v.mapped ? "" : `; not mapped at ${mfgCode} (no recipe)`}`
    }
    case "unmapped":
      return `Not mapped at ${mfgCode} — no recipe, will be raised unpriced`
    case "zero":
      return "Costing totals ₹0 — will be raised unpriced"
    case "priced":
      return priced()
    case "partial": {
      const gaps = [v.rmMissing ? `${v.rmMissing} RM` : "", v.pmMissing ? `${v.pmMissing} PM` : ""].filter(Boolean).join(", ")
      return `${priced()} — costing incomplete: ${gaps} lines without rate`
    }
  }
}

/** The price the server staged at upload, or null when the row predates staging
 *  (no `priced_at`) and must be resolved at approval. Blank = unpriced. */
export function stagedPrice(row: Record<string, string | undefined>): PoPrice | null {
  if (!row.priced_at?.trim()) return null
  if (isSpecialPoType(row.po_type)) return specialPoPrice()
  const qty = Number(row.qty)
  // Recomputed from the staged rate and GST rather than trusting three staged figures.
  return poTotal(row.unit_price, Number.isFinite(qty) ? qty : 0, row.gst_percent)
}
