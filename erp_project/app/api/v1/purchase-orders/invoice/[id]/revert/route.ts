// POST /api/v1/purchase-orders/invoice/[id]/revert
// Request a revert of an inwarded invoice. Writes only the INVOICE_REVERT approval; the revert
// itself happens on approval (lib/approvals/handlers/invoice-revert.ts). dry_run previews it.
// See docs/invoice-revert-plan.md §3 and §8a.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { approvalsSql } from "@/lib/queries/approvals"
import { invoiceRevertSql } from "@/lib/queries/invoice-revert"
import { invoiceIdParamSchema, invoiceRevertSchema } from "@/lib/validation/invoice-verify"
import { assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { assertPoInScope } from "@/lib/po/po-guard"
import { assertNoLiveGrn, planInvoiceRevert } from "@/lib/invoice/invoice-revert"
import logger from "@/lib/logger"

type Header = {
  id: number; invoice_no: string; mfg_id: number; mfg_name: string
  destination: string | null; buyer_gstin: string | null; uniware_po_code: string | null
  reverted_at: string | Date | null
}

export const POST = withGateway({
  paramsSchema: invoiceIdParamSchema,
  schema: invoiceRevertSchema,
  // Whoever may inward an invoice may ask to revert it (D3).
  access: { pageSlug: ["/po-tracking/invoices", "/po-tracking/po-inwarding"], level: "editor" },
  scope: { type: "invoice", from: ({ params }) => params.id },
  handler: async ({ params, body, session, ctx }) => {
    const userId = Number(session.user.id)
    const invoiceId = params.id

    const [header] = await query<Header>(invoiceRevertSql.selectHeader, [invoiceId])
    if (!header) throw new ApiError(404, "not_found", `Invoice id=${invoiceId} not found`)
    if (header.reverted_at) throw new ApiError(409, "invoice_reverted", `Invoice ${header.invoice_no} was already reverted.`)

    // Every line's SKU and every PO it touched must be the requester's (D3, review M1). Pool reads,
    // so they run before the transaction holds any lock.
    const refs = await query<{ sku_code: string | null; po_id: number | null; received_against_po_id: number | null }>(
      invoiceRevertSql.selectLineRefs, [invoiceId],
    )
    await assertSkuCodesInBrandScope(userId, [...new Set(refs.map((r) => r.sku_code).filter((s): s is string => !!s))])
    const poIds = [...new Set(refs.flatMap((r) => [r.po_id, r.received_against_po_id]).filter((id): id is number => id != null))]
    for (const poId of poIds) await assertPoInScope(userId, poId)

    if (!body.dry_run && body.confirm_invoice_no !== header.invoice_no) {
      throw new ApiError(400, "confirm_mismatch", "Type the invoice number exactly to confirm.")
    }

    // Live GRN search, before any lock (D17, D18).
    await assertNoLiveGrn(header)

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      // Locks the invoice first, so two concurrent requests serialise on hasPending below.
      const plan = await planInvoiceRevert(conn, invoiceId)
      const [pending] = await conn.execute(approvalsSql.hasPending, ["INVOICE_REVERT", invoiceId])
      if ((pending as unknown[]).length) {
        throw new ApiError(409, "revert_pending", `A revert of ${header.invoice_no} is already waiting for approval.`)
      }

      const preview = {
        invoice_no: header.invoice_no,
        mfg_name: header.mfg_name,
        uniware_po_code: header.uniware_po_code,
        receipts: plan.receipts,
        inward_pos: plan.inward.map((i) => ({ po_id: i.po_id, po_no: i.po_no, status_before: i.status_before })),
      }
      if (body.dry_run) {
        await conn.rollback()
        return NextResponse.json({ ok: true, plan: preview })
      }

      const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "INVOICE_REVERT", invoiceId, "edit"])
      const approvalId = (ar as { insertId: number }).insertId
      // Display only — the handler re-plans from live rows. invoice_no old = new keeps it under Edits.
      const items: [string, string, string][] = [
        ["invoice_no", header.invoice_no, header.invoice_no],
        ["manufacturer", "", header.mfg_name],
        ["reason", "", body.reason],
        ...plan.receipts.map((r): [string, string, string] => [`receipt:${r.po_no}`, String(r.before), String(r.after)]),
        ...plan.receipts.filter((r) => r.reopen).map((r): [string, string, string] => [`reopen:${r.po_no}`, "received", "raised"]),
        ...plan.inward.map((i): [string, string, string] => [`inward_po:${i.po_no}`, i.status_before ?? "", "reverted"]),
      ]
      for (const [field, oldV, newV] of items) {
        await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldV, newV])
      }

      await conn.commit()
      logger.info({ ...ctx, invoiceId, approvalId, message: "Invoice revert requested" })
      return NextResponse.json({ ok: true, approval_id: approvalId })
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  },
})
