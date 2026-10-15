// Revert an inwarded invoice without deleting anything. See docs/invoice-revert-plan.md §5–6.
// Takes the caller's connection and opens no transaction (nested BEGIN implicitly commits).

import type { PoolConnection } from "mysql2/promise"
import { ApiError } from "@/lib/gateway/errors"
import { formatDateTimeIST } from "@/lib/date"
import { invoiceRevertSql } from "@/lib/queries/invoice-revert"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { uniwareEnabled } from "@/lib/uniware/auth"
import { fetchInflowReceiptCodes } from "@/lib/uniware/grn"
import { requireFacilityForInvoice } from "@/lib/uniware/facility-resolve"
import {
  planReversal, revertReasonNote, type InwardRevert, type ReceiptReversal, type RevertLine, type RevertPo,
} from "./invoice-revert-rules"

type InvoiceRow = {
  id: number
  invoice_no: string
  mfg_id: number
  destination: string | null
  buyer_gstin: string | null
  uniware_po_code: string | null
  uniware_grn_count: number | null
  reverted_at: string | Date | null
}

export type InvoiceRevertPlan = {
  invoice: InvoiceRow
  receipts: ReceiptReversal[]
  inward: InwardRevert[]
  /** Every PO the invoice touched — procurement and inward — for scope checks and history. */
  poIds: number[]
  poNoById: Map<number, string>
}

const rows = <T>(r: unknown) => (r as [T[], unknown])[0]

/**
 * Lock the invoice, its lines and every PO they touch, check every local guard, and say what a
 * revert would do. Writes nothing. Lock order: invoice, lines, POs by ascending id.
 */
export async function planInvoiceRevert(conn: PoolConnection, invoiceId: number): Promise<InvoiceRevertPlan> {
  const [invoice] = rows<InvoiceRow>(await conn.query(invoiceRevertSql.lockInvoice, [invoiceId]))
  if (!invoice) throw new ApiError(404, "not_found", `Invoice id=${invoiceId} not found`)
  if (invoice.reverted_at) {
    throw new ApiError(409, "invoice_reverted", `Invoice ${invoice.invoice_no} was already reverted on ${formatDateTimeIST(invoice.reverted_at)}.`)
  }

  const [b] = rows<{ grn_rows: number; payment_rows: number; verified_legs: number; uniware_grn_count: number }>(
    await conn.query(invoiceRevertSql.blockers, [invoiceId, invoiceId, invoiceId, invoiceId]),
  )
  if (Number(b.grn_rows) > 0 || Number(b.uniware_grn_count) > 0) {
    throw new ApiError(409, "grn_recorded", `Uniware already shows a GRN for ${invoice.invoice_no} — reverse it there first.`)
  }
  if (Number(b.payment_rows) > 0) {
    throw new ApiError(409, "payment_recorded", `A payment state is recorded on ${invoice.invoice_no} — clear it first.`)
  }
  if (Number(b.verified_legs) > 0) {
    throw new ApiError(409, "legs_verified", `${invoice.invoice_no} has verified legs — withdraw them first.`)
  }

  const lines = rows<RevertLine & { id: number }>(await conn.query(invoiceRevertSql.lockLines, [invoiceId]))
  const poIds = [...new Set(lines.flatMap((l) => [l.po_id, l.received_against_po_id]).filter((id): id is number => id != null))]
    .sort((a, b2) => a - b2)
  const pos = poIds.length ? rows<RevertPo & { po_type: string | null }>(await conn.query(invoiceRevertSql.lockPos, [poIds])) : []

  // A split parent is never reopened: read what it has handed to live children.
  for (const po of pos) {
    if (po.po_type === "inward") continue
    const [split] = rows<{ allocated_qty: string }>(await conn.query(purchaseOrdersSql.childSplitSummary, [po.po_no, po.po_no]))
    po.allocated_qty = Number(split?.allocated_qty ?? 0)
  }

  const inwardIds = [...new Set(lines.map((l) => l.po_id).filter((id): id is number => id != null))]
  if (inwardIds.length) {
    const shared = rows<{ po_no: string }>(await conn.query(invoiceRevertSql.sharedInward, [inwardIds, invoiceId]))
    if (shared.length) {
      throw new ApiError(409, "inward_po_shared", `Inward PO ${shared.map((s) => s.po_no).join(", ")} is shared with another record.`)
    }
  }

  const plan = planReversal(lines, pos)
  if (!plan.ok) throw new ApiError(409, plan.code, plan.error)

  return { invoice, receipts: plan.receipts, inward: plan.inward, poIds, poNoById: new Map(pos.map((p) => [p.id, p.po_no])) }
}

/**
 * Ask Uniware, live, whether any GRN exists against the invoice's mirrored PO. Any GRN, or no
 * answer at all, refuses. An invoice never mirrored has nothing to ask about.
 */
export async function assertNoLiveGrn(invoice: Pick<InvoiceRow, "invoice_no" | "uniware_po_code" | "destination" | "buyer_gstin">): Promise<void> {
  if (!invoice.uniware_po_code) return
  const unreachable = () =>
    new ApiError(503, "uniware_unreachable", "Couldn't reach Uniware to check for GRNs — please try again later.")
  if (!uniwareEnabled()) throw unreachable()

  let codes: string[]
  try {
    codes = await fetchInflowReceiptCodes(invoice.uniware_po_code, await requireFacilityForInvoice(invoice))
  } catch {
    throw unreachable()
  }
  if (codes.length) {
    throw new ApiError(409, "uniware_grn_exists",
      `This invoice can't be reverted — goods are already received in Uniware. Uniware PO ${invoice.uniware_po_code} has ` +
      `${codes.length === 1 ? "GRN" : "GRNs"} ${codes.join(", ")}. Reverse ${codes.length === 1 ? "this GRN" : "these GRNs"} ` +
      `in Uniware first, then request the revert again.`,
      { uniware_po_code: invoice.uniware_po_code, grn_codes: codes })
  }
}

export type ApplyRevertOptions = {
  reason: string
  requestedBy: number
  approvedBy: number
  approvalId: number | null
  /** The live Uniware GRN check, run after the locks and before any write. */
  checkLiveGrn?: (invoice: InvoiceRow) => Promise<void>
}

/** Do the revert: reverse receipts, reopen, mark the inward POs reverted, stamp the invoice. Asserts its counts. */
export async function applyInvoiceRevert(conn: PoolConnection, invoiceId: number, opts: ApplyRevertOptions) {
  const plan = await planInvoiceRevert(conn, invoiceId)
  await opts.checkLiveGrn?.(plan.invoice)

  const note = revertReasonNote(plan.invoice.invoice_no, opts.approvalId, opts.reason)
  const by = opts.requestedBy
  const history = (poId: number, field: string, oldV: string | null, newV: string | null) =>
    conn.execute(purchaseOrdersSql.insertPoHistory, [poId, plan.poNoById.get(poId) ?? "", "update", field, oldV, newV, null, by])

  for (const r of plan.receipts) {
    await conn.execute(invoiceRevertSql.setReceived, [r.after, r.po_id])
    await history(r.po_id, "received_qty", String(r.before), String(r.after))
    if (r.reopen) {
      const [res] = await conn.execute(invoiceRevertSql.reopen, [r.po_id])
      if ((res as { affectedRows: number }).affectedRows === 1) await history(r.po_id, "status", "received", "raised")
    }
  }

  if (plan.inward.length) {
    const [res] = await conn.query(invoiceRevertSql.revertInward, [plan.inward.map((i) => i.po_id)])
    const marked = (res as { affectedRows: number }).affectedRows
    if (marked !== plan.inward.length) {
      throw new Error(`Revert of ${plan.invoice.invoice_no}: marked ${marked} inward POs reverted, expected ${plan.inward.length}`)
    }
    for (const i of plan.inward) await history(i.po_id, "status", i.status_before, "reverted")
  }

  for (const poId of plan.poIds) await history(poId, "revert_reason", null, note)

  const [stamp] = await conn.execute(invoiceRevertSql.stampInvoice, [
    opts.requestedBy, opts.approvedBy, opts.approvalId, opts.reason.trim().slice(0, 500), invoiceId,
  ])
  if ((stamp as { affectedRows: number }).affectedRows !== 1) {
    throw new Error(`Revert of ${plan.invoice.invoice_no}: invoice was not stamped`)
  }
  return plan
}

/**
 * Refuse a write to an invoice that is reverted or has a revert waiting. Shares the header row
 * so the check and the caller's write sit in one transaction.
 */
export async function assertInvoiceWritable(conn: PoolConnection, invoiceId: number): Promise<void> {
  const [s] = rows<{ reverted_at: string | Date | null; revert_pending: number }>(
    await conn.query(invoiceRevertSql.shareInvoiceState, [invoiceId]),
  )
  if (!s) throw new ApiError(404, "not_found", `Invoice id=${invoiceId} not found`)
  if (s.reverted_at) throw new ApiError(409, "invoice_reverted", "This invoice was reverted and can no longer change.")
  if (Number(s.revert_pending)) {
    throw new ApiError(409, "revert_pending", "A revert of this invoice is waiting for approval — it can't change until that's decided.")
  }
}

