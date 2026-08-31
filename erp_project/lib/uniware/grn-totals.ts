/**
 * Roll-ups and the three-way reconciliation behind the inwarding panel's
 * Accepted / Rejected / Awaited figures. PURE — no DB, no network, so
 * tests/unit can import it (AGENTS.md). Same reason lib/po-split.ts and
 * lib/invoice/invoice-merge.ts are extracted from the routes they serve.
 *
 * ── THE THREE NUMBERS ────────────────────────────────────────────────────────
 *   Ordered   purchase_orders.qty        what we asked for
 *   Invoiced  invoice_items_mfg.qty      what the manufacturer billed
 *   Accepted  + Rejected (GRN)           what the warehouse actually took
 *
 * These are three different claims by three different parties, and each gap has
 * a different owner. Collapsing them into one "received" number — which is what
 * purchase_orders.received_qty is — is precisely what hid rejected quantity.
 *
 * NOTHING here writes anywhere. received_qty stays our own record of what we
 * were told arrived; the disagreement with Accepted is the reportable fact.
 */

/** One GRN line, already mapped and resolved to one of our inward POs. */
export type GrnTotalRow = {
  /** Null when the warehouse received a SKU we never raised — see the schema. */
  poId: number | null
  grnCode: string
  quantity: number
  rejectedQty: number
  receivedAt: Date | null
}

export type PoGrnTotals = {
  accepted: number
  rejected: number
  /** Distinct GRNs touching this PO, not line count. */
  grnCount: number
  lastReceivedAt: Date | null
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Per-PO roll-up across every GRN line.
 *
 * Lines with no `poId` are skipped rather than bucketed under a sentinel: they
 * are a reconciliation finding of their own (query the NULLs directly), and
 * folding them into a real PO's totals would overstate that PO's receipts.
 */
export function grnTotalsByPo(rows: GrnTotalRow[]): Map<number, PoGrnTotals> {
  const out = new Map<number, PoGrnTotals>()
  const seenGrns = new Map<number, Set<string>>()

  for (const r of rows) {
    if (r.poId == null) continue

    const t = out.get(r.poId) ?? { accepted: 0, rejected: 0, grnCount: 0, lastReceivedAt: null }
    t.accepted += num(r.quantity)
    t.rejected += num(r.rejectedQty)
    if (r.receivedAt && (!t.lastReceivedAt || r.receivedAt > t.lastReceivedAt)) {
      t.lastReceivedAt = r.receivedAt
    }

    // Counted per DISTINCT grn_code: one GRN usually carries several lines for
    // the same PO, so counting rows would report "3 GRNs" for one receipt.
    const codes = seenGrns.get(r.poId) ?? new Set<string>()
    codes.add(r.grnCode)
    seenGrns.set(r.poId, codes)
    t.grnCount = codes.size

    out.set(r.poId, t)
  }
  return out
}

export type Reconciliation = {
  accepted: number
  rejected: number
  /** Billed but not yet accounted for at the dock. Never negative. */
  awaited: number
  /** The warehouse took more than was billed. Never negative. */
  overReceipt: number
  /** rejected / (accepted + rejected). Null when nothing has been received. */
  rejectRate: number | null
}

/**
 * The gap analysis for ONE inward PO.
 *
 * `awaited` and `overReceipt` are deliberately two one-sided numbers rather than
 * a single signed difference: they mean opposite things operationally (chase the
 * manufacturer vs query the warehouse), and a signed number forces every caller
 * to re-derive which case it is looking at.
 */
export function reconcile(input: {
  orderedQty: number | string | null
  invoicedQty: number | string | null
  accepted: number | string | null
  rejected: number | string | null
}): Reconciliation {
  const invoiced = num(input.invoicedQty)
  const accepted = num(input.accepted)
  const rejected = num(input.rejected)

  const handled = accepted + rejected
  const diff = invoiced - handled

  return {
    accepted,
    rejected,
    awaited: diff > 0 ? diff : 0,
    overReceipt: diff < 0 ? -diff : 0,
    // Null, not 0: "nothing received yet" and "received, none rejected" are
    // different states and a 0% badge on the former reads as a clean receipt.
    rejectRate: handled > 0 ? rejected / handled : null,
  }
}

/**
 * What the rejected units were worth.
 *
 * The rate is OURS — invoice_items_mfg.rate — not Uniware's. `unitPrice` is
 * confirmed on PO items but not on receipt items, and our invoice rate is the
 * number a debit note would actually be raised against. If a receipt-level
 * unitPrice turns up at Gate 0, show it beside this as a discrepancy rather than
 * replacing it.
 *
 * Null rate ⇒ null, never 0: an unpriced line is unknown value, and a ₹0 badge
 * beside 150 rejected units reads as "no loss".
 */
export function rejectedAmount(
  rejectedQty: number | string | null,
  invoiceRate: number | string | null
): number | null {
  if (invoiceRate == null || invoiceRate === "") return null
  const rate = Number(invoiceRate)
  if (!Number.isFinite(rate)) return null
  return num(rejectedQty) * rate
}
