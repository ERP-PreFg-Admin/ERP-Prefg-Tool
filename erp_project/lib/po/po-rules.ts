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

/** A split child's price: the rate in paise, amount = that rate × the child's qty
 *  (same rounding as lib/po/po-rate.ts). No rate → NULL, never 0. */
export function splitChildPrice(
  unitPrice: number | string | null | undefined,
  qty: number
): { unitPrice: number | null; totalAmount: number | null } {
  const rate = unitPrice == null || unitPrice === "" ? NaN : Number(unitPrice)
  if (!Number.isFinite(rate) || rate <= 0) return { unitPrice: null, totalAmount: null }
  const rounded = Number(rate.toFixed(2))
  return { unitPrice: rounded, totalAmount: Number((rounded * qty).toFixed(2)) }
}
