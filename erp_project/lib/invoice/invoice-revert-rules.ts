// Pure rules for reverting an inwarded invoice. No DB — wired in lib/invoice/invoice-revert.ts.
// See docs/invoice-revert-plan.md §5.

import { poTolerance } from "@/lib/po/po-rules"

export type RevertLine = {
  po_id: number | null
  received_against_po_id: number | null
  qty: number | string
}

export type RevertPo = {
  id: number
  po_no: string
  status: string | null
  qty: number | string
  received_qty: number | string | null
  /** Qty handed to live split children (childSplitSummary). A split parent is never reopened. */
  allocated_qty?: number | string | null
}

export type ReceiptReversal = { po_id: number; po_no: string; before: number; after: number; reopen: boolean }
export type InwardRevert = { po_id: number; po_no: string; status_before: string | null }

export type RevertPlanResult =
  | { ok: true; receipts: ReceiptReversal[]; inward: InwardRevert[] }
  | { ok: false; code: "po_below_zero" | "inward_po_reverted" | "po_missing"; error: string }

const n = (v: number | string | null | undefined) => Number(v ?? 0)
// DECIMAL(12,3): anything under this is float noise.
const EPS = 0.0005

/**
 * What a revert does to each PO, or why it can't. `pos` holds every PO the lines
 * point at, both procurement (received_against_po_id) and inward (po_id).
 */
export function planReversal(lines: RevertLine[], pos: RevertPo[]): RevertPlanResult {
  const byId = new Map(pos.map((p) => [p.id, p]))

  const qtyByPo = new Map<number, number>()
  for (const l of lines) {
    if (l.received_against_po_id == null) continue
    qtyByPo.set(l.received_against_po_id, (qtyByPo.get(l.received_against_po_id) ?? 0) + n(l.qty))
  }

  const receipts: ReceiptReversal[] = []
  for (const [poId, qty] of [...qtyByPo].sort((a, b) => a[0] - b[0])) {
    const po = byId.get(poId)
    if (!po) return { ok: false, code: "po_missing", error: `PO id=${poId} that this invoice received against no longer exists — needs a manual fix.` }
    const before = n(po.received_qty)
    const after = round3(before - qty)
    if (after < -EPS) {
      return { ok: false, code: "po_below_zero", error: `PO ${po.po_no} would go below zero received (${before} − ${qty}) — needs a manual fix.` }
    }
    receipts.push({ po_id: poId, po_no: po.po_no, before, after: Math.max(after, 0), reopen: shouldReopen(po, Math.max(after, 0)) })
  }

  const inwardIds = [...new Set(lines.map((l) => l.po_id).filter((id): id is number => id != null))].sort((a, b) => a - b)
  const inward: InwardRevert[] = []
  for (const id of inwardIds) {
    const po = byId.get(id)
    if (!po) return { ok: false, code: "po_missing", error: `Inward PO id=${id} no longer exists — needs a manual fix.` }
    if (po.status === "reverted") return { ok: false, code: "inward_po_reverted", error: `Inward PO ${po.po_no} is already reverted — data needs a manual check.` }
    // Whatever it was before (received, or cancelled by the Uniware sweep), it becomes 'reverted'.
    inward.push({ po_id: id, po_no: po.po_no, status_before: po.status })
  }

  return { ok: true, receipts, inward }
}

/**
 * Reopen only what the reverted receipt had auto-closed: stored 'received', not a split
 * parent, and now outside tolerance. A person's short_closed / cancelled is kept.
 */
export function shouldReopen(po: Pick<RevertPo, "status" | "qty" | "allocated_qty">, receivedAfter: number): boolean {
  if (po.status !== "received") return false
  if (n(po.allocated_qty) > 0) return false
  return n(po.qty) - receivedAfter > poTolerance(n(po.qty))
}

/** The history_pos note every touched PO gets; new_value is VARCHAR(255). */
export function revertReasonNote(invoiceNo: string, approvalId: number | null, reason: string): string {
  const head = `Invoice ${invoiceNo} reverted${approvalId ? ` (approval #${approvalId})` : ""}: `
  const text = head + reason.trim().replace(/\s+/g, " ")
  return text.length > 255 ? text.slice(0, 254) + "…" : text
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
