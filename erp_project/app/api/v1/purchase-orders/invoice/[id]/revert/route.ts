// POST /api/v1/purchase-orders/invoice/[id]/revert
// Request a revert of an inwarded invoice. Writes only the INVOICE_REVERT approval; the revert
// itself happens on approval (lib/approvals/handlers/invoice-revert.ts). dry_run previews it.
// See docs/invoice-revert-plan.md §3 and §8a.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { invoiceRevertSql } from "@/lib/queries/invoice-revert"
import { invoiceIdParamSchema, invoiceRevertSchema } from "@/lib/validation/invoice-verify"
import { assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { assertPoInScope } from "@/lib/po/po-guard"
import { assertNoLiveGrn, stageInvoiceRevertRequest } from "@/lib/invoice/invoice-revert"
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
      const { approvalId, preview } = await stageInvoiceRevertRequest(conn, header, userId, body.reason, body.dry_run)
      if (body.dry_run) {
        await conn.rollback()
        return NextResponse.json({ ok: true, plan: preview })
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
