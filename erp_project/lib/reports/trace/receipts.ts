// T3 provenance and T4 receipt-event matching. Pure.
// Rules: docs/reporting/dataset-contracts.md T3 and T4.

const EPS = 0.0005

export type Provenance =
  | "all_invoiced" | "partly_without_invoice" | "no_invoice" | "opening_balance" | "nothing_received" | "data_error"

/** Where a PO's own received_qty came from. */
export function provenance(p: { received_own: number; invoiced_live: number; opening_balance: number }): Provenance {
  if (Math.abs(p.received_own) < EPS && Math.abs(p.invoiced_live) < EPS) return "nothing_received"
  const without = p.received_own - p.invoiced_live
  if (without < -EPS) return "data_error"
  if (Math.abs(without) < EPS) return "all_invoiced"
  if (p.invoiced_live < EPS) return p.opening_balance > EPS ? "opening_balance" : "no_invoice"
  return "partly_without_invoice"
}

export type ReceiptEvent = {
  history_id: number
  po_id: number
  /** epoch ms */
  changed_at: number
  changed_by: number | null
  delta: number
  /** A revert_reason row on the same PO within ±2s. */
  revert_nearby: boolean
}

export type ReceiptLine = {
  line_id: number
  invoice_id: number
  invoice_no: string
  po_id: number
  qty: number
  /** invoice_mfg.created_at, epoch ms */
  inwarded_at: number
}

export type ReceiptSource = "invoice" | "invoice_revert" | "backfill" | "hand_fix" | "manual" | "unknown"

export type ClassifiedEvent = {
  history_id: number
  source: ReceiptSource
  confidence: "exact" | "heuristic" | "none"
  line_id: number | null
  invoice_id: number | null
  invoice_no: string | null
  seconds_after_invoice: number | null
}

/** Match window around the invoice header insert: the receipt runs inside the same transaction. */
export const MATCH_WINDOW = { beforeMs: 5_000, afterMs: 120_000 }

/** Known out-of-band writers (docs/reporting/traceability-plan.md). */
function unmatchedSource(e: ReceiptEvent): ReceiptSource {
  const day = new Date(e.changed_at + 5.5 * 3_600_000).toISOString().slice(0, 10) // IST
  if (e.changed_by === 10 && day.startsWith("2026-09")) return "backfill"
  if (e.changed_by === 2 && day === "2026-10-19") return "hand_fix"
  return e.delta > 0 ? "manual" : "unknown"
}

/**
 * One-to-one match of positive receipt deltas to invoice lines (same PO, same qty, inside the window).
 * Nearest in time wins; `exact` when the pair was the only candidate on both sides.
 */
export function classifyReceipts(events: readonly ReceiptEvent[], lines: readonly ReceiptLine[]): ClassifiedEvent[] {
  type Pair = { e: ReceiptEvent; l: ReceiptLine; dist: number }
  const pairs: Pair[] = []
  const linesByPo = new Map<number, ReceiptLine[]>()
  for (const l of lines) linesByPo.set(l.po_id, [...(linesByPo.get(l.po_id) ?? []), l])

  for (const e of events) {
    if (e.delta <= 0) continue
    for (const l of linesByPo.get(e.po_id) ?? []) {
      const dt = e.changed_at - l.inwarded_at
      if (Math.abs(l.qty - e.delta) < EPS && dt >= -MATCH_WINDOW.beforeMs && dt <= MATCH_WINDOW.afterMs) {
        pairs.push({ e, l, dist: Math.abs(dt) })
      }
    }
  }
  const candidatesPerEvent = new Map<number, number>()
  const candidatesPerLine = new Map<number, number>()
  for (const p of pairs) {
    candidatesPerEvent.set(p.e.history_id, (candidatesPerEvent.get(p.e.history_id) ?? 0) + 1)
    candidatesPerLine.set(p.l.line_id, (candidatesPerLine.get(p.l.line_id) ?? 0) + 1)
  }
  pairs.sort((a, b) => a.dist - b.dist || a.e.history_id - b.e.history_id || a.l.line_id - b.l.line_id)

  const byEvent = new Map<number, Pair>()
  const usedLines = new Set<number>()
  for (const p of pairs) {
    if (byEvent.has(p.e.history_id) || usedLines.has(p.l.line_id)) continue
    byEvent.set(p.e.history_id, p)
    usedLines.add(p.l.line_id)
  }

  return events.map((e): ClassifiedEvent => {
    const p = byEvent.get(e.history_id)
    if (p) {
      const sole = candidatesPerEvent.get(e.history_id) === 1 && candidatesPerLine.get(p.l.line_id) === 1
      return {
        history_id: e.history_id, source: "invoice", confidence: sole ? "exact" : "heuristic",
        line_id: p.l.line_id, invoice_id: p.l.invoice_id, invoice_no: p.l.invoice_no,
        seconds_after_invoice: Math.round((e.changed_at - p.l.inwarded_at) / 1000),
      }
    }
    if (e.delta < 0 && e.revert_nearby) {
      return { history_id: e.history_id, source: "invoice_revert", confidence: "heuristic",
        line_id: null, invoice_id: null, invoice_no: null, seconds_after_invoice: null }
    }
    return { history_id: e.history_id, source: unmatchedSource(e), confidence: "none",
      line_id: null, invoice_id: null, invoice_no: null, seconds_after_invoice: null }
  })
}
