// Shared business rules for purchase-order qty/status math — used both
// server-side (split/receive routes deciding when a PO is done) and
// client-side (PO tracking UI deciding when to show close-eligibility hints).
// Keeping one implementation means the two can't silently disagree on the
// tolerance policy.

/** A PO with `remaining <= poTolerance(qty)` is considered fully closed out. */
export function poTolerance(qty: number): number {
  return Math.min(100, Math.floor(qty * 0.10))
}
