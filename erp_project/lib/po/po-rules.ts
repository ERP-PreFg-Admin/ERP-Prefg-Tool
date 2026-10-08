// Shared business rules for purchase-order qty/status math — used both
// server-side (split/receive routes deciding when a PO is done) and
// client-side (PO tracking UI deciding when to show close-eligibility hints).
// Keeping one implementation means the two can't silently disagree on the
// tolerance policy.

/** A PO with `remaining <= poTolerance(qty)` is considered fully closed out. */
export function poTolerance(qty: number): number {
  return Math.min(100, Math.floor(qty * 0.10))
}

/**
 * Is this PO a draft, as PO Tracking means it?
 *
 * Not the same question as `status === 'draft'`. DISPLAY_STATUS_EXPR (see
 * lib/queries/purchase-orders.ts) reads a stored-'raised' PO with no
 * `email_sent_at` back as Draft, because a PO the manufacturer has not been
 * told about isn't really raised. That is what the Draft tab lists, so it is
 * what "no splitting a draft" has to mean too — anything narrower lets a row
 * badged Draft be split anyway.
 *
 * Inward POs are exempt from that derivation (there is no procurement mail for
 * them), but they are never splittable on any path, so they don't need a case
 * here.
 */
export function isDraftPo(po: { status: string | null; email_sent_at: string | Date | null }): boolean {
  return po.status === "draft" || (po.status === "raised" && !po.email_sent_at)
}

/** PO types a bulk CSV may carry. Blank = normal; inward is invoice-only. */
export const BULK_PO_TYPES = ["normal", "impromptu", "npd", "tech_transfer", "cpr"] as const
export type BulkPoType = (typeof BULK_PO_TYPES)[number]

/** Raised at price 0, at most one live PO per (sku, mfg, type). */
export const SPECIAL_PO_TYPES = ["npd", "tech_transfer", "cpr"] as const
export type SpecialPoType = (typeof SPECIAL_PO_TYPES)[number]

export const SPECIAL_PO_LABEL: Record<SpecialPoType, string> = { npd: "NPD", tech_transfer: "Tech Transfer", cpr: "CPR" }

export const isSpecialPoType = (t: unknown): t is SpecialPoType =>
  (SPECIAL_PO_TYPES as readonly string[]).includes(String(t ?? ""))

/** The CSV cell → a type, or "invalid". Blank (or no column) is normal; "Tech Transfer" / "tech-transfer" read as tech_transfer. */
export function parseBulkPoType(cell: unknown): BulkPoType | "invalid" {
  const v = String(cell ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!v) return "normal"
  return (BULK_PO_TYPES as readonly string[]).includes(v) ? (v as BulkPoType) : "invalid"
}

/** The PO document's declaration. A special PO states no price, so it can't
 *  affirm "the actual price of the goods". */
export function poDeclaration(poType: unknown): string {
  return isSpecialPoType(poType)
    ? `This is ${poType === "npd" ? "an" : "a"} ${SPECIAL_PO_LABEL[poType]} order. Pricing will be confirmed separately; the supplier's invoice governs.`
    : "We declare that this purchase order the actual price of the goods described and that all particulars are true and correct."
}

/** Impromptu and the special types must say why they're being raised. */
export const poTypeRequiresRemarks = (t: BulkPoType): boolean => t === "impromptu" || isSpecialPoType(t)

/** Used only when a SKU has no GST on master_skus — what every PO printed before. */
export const DEFAULT_GST_PERCENT = 18

export type PoPrice = {
  unitPrice: number | null
  gstPercent: number
  amountPreGst: number | null
  totalAmount: number | null
}

const toNum = (v: unknown): number => (v == null || v === "" ? NaN : Number(v))

/** A PO's price: rate in paise, amount = rate × qty, total = amount + the SKU's GST.
 *  No rate → amounts NULL, never 0. */
export function poTotal(unitPrice: unknown, qty: number, gstPercent: unknown): PoPrice {
  const g = toNum(gstPercent)
  const gst = Number.isFinite(g) && g >= 0 ? g : DEFAULT_GST_PERCENT
  const rate = toNum(unitPrice)
  if (!Number.isFinite(rate) || rate <= 0) return { unitPrice: null, gstPercent: gst, amountPreGst: null, totalAmount: null }
  const rounded = Number(rate.toFixed(2))
  const amountPreGst = Number((rounded * qty).toFixed(2))
  return { unitPrice: rounded, gstPercent: gst, amountPreGst, totalAmount: Number((amountPreGst * (1 + gst / 100)).toFixed(2)) }
}

/** The GST % a PO was raised at, implied by its own two amounts — so a later change
 *  to master_skus.gst never relabels a PO already sent. Null without amount_pre_gst. */
export function impliedGstPercent(amountPreGst: unknown, totalAmount: unknown): number | null {
  const pre = toNum(amountPreGst)
  const total = toNum(totalAmount)
  if (!Number.isFinite(pre) || pre <= 0 || !Number.isFinite(total)) return null
  // Paise rounding on the total leaves noise past one decimal; GST rates are whole or .5.
  return Math.round((total / pre - 1) * 1000) / 10
}

/** A special-type PO's price: a stored 0 (a NULL can't go on the PDF). poTotal
 *  would read a 0 rate as "no price", hence its own function. */
export const specialPoPrice = (): PoPrice => ({ unitPrice: 0, gstPercent: 0, amountPreGst: 0, totalAmount: 0 })

/** What a PO document prints: its stored amounts when it has amount_pre_gst;
 *  otherwise (inward POs) today's output — the total plus a flat 18%. A special
 *  PO prints 0s and no GST label (gstPercent null). */
export function poPrintedAmounts(d: {
  amount_pre_gst?: unknown; total_amount: unknown; po_type?: unknown
}): { base: number; gst: number; grand: number; gstPercent: number | null } {
  if (isSpecialPoType(d.po_type)) return { base: 0, gst: 0, grand: 0, gstPercent: null }
  const pre = toNum(d.amount_pre_gst)
  const total = toNum(d.total_amount)
  const pct = impliedGstPercent(pre, total)
  if (pct != null) {
    return { base: pre, gst: Number((total - pre).toFixed(2)), grand: total, gstPercent: pct }
  }
  const base = Number.isFinite(total) && total > 0 ? total : 0
  const gst = base > 0 ? Math.round(base * DEFAULT_GST_PERCENT / 100) : 0
  return { base, gst, grand: base + gst, gstPercent: DEFAULT_GST_PERCENT }
}

/** A split child takes the parent PO's rate AND its GST %: the same order, divided. */
export const splitChildPrice = (parentUnitPrice: unknown, qty: number, parentGstPercent: unknown): PoPrice =>
  poTotal(parentUnitPrice, qty, parentGstPercent)
