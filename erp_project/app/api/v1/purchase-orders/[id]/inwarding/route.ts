// GET /api/v1/purchase-orders/[id]/inwarding
//
// Everything inwarded against one PO, for the FG PO Tracking detail panel.
//
// ── Why `withoutInvoice` is a number and not a list ─────────────────────────
// Both receipt paths funnel through receivePo() in lib/po/po-receive.ts — the manual
// Receive dialog and the invoice flow in lib/invoice/invoice-inward.ts — and each writes an
// identical history_pos row (field_name='received_qty', s3_key always null). No
// column distinguishes a desk receipt from an invoice receipt, so merging the
// invoice lines with the receipt log would list every invoice-driven receipt twice,
// and correlating them on (qty, timestamp) mis-pairs whenever two equal receipts
// land on one day.
//
// So the shortfall is derived by subtraction instead: whatever received_qty exceeds
// the invoice-linked total arrived without a document. That cannot double-count, and
// it needs no schema change. The per-event log is already available through the
// row's History action.

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertPoInScope } from "@/lib/po/po-guard"
import { poIdParamSchema } from "@/lib/validation/purchase-order-detail"
import logger from "@/lib/logger"
import type { InwardingHeader, InwardingLine } from "@/app/po-tracking/po-procurement/po-types"

export const GET = withGateway({
    // SES, one send per manufacturer. concurrency 1 stops a double-click mailing
  // a manufacturer twice — email_sent_at's IS NULL guard makes the stamp safe,
  // but the mail itself has already gone out by then.
  rateLimit: { limit: 10, windowMs: 10 * 60_000, concurrency: 1 },
  paramsSchema: poIdParamSchema,
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ params, session, ctx }) => {
    const poId = params.id
    const logCtx = { ...ctx, route: `/api/v1/purchase-orders/${poId}/inwarding` }

    // PO ids are sequential integers, so the scope-filtered list is not a
    // boundary — without this a user scoped to one manufacturer could read
    // another's inwarding by guessing an id. Throws 404 / 403.
    await assertPoInScope(Number(session.user.id), poId)

    const [header] = await query<InwardingHeader>(supplierInvoicesSql.selectInwardingHeader, [poId])
    if (!header) throw new ApiError(404, "not_found", "Purchase order not found")

    const lines = await query<InwardingLine>(supplierInvoicesSql.selectByPoId, [poId, poId])

    const invoiced = lines.reduce((sum, l) => sum + Number(l.line_qty ?? 0), 0)
    const withoutInvoice = Math.max(0, Number(header.received_qty ?? 0) - invoiced)

    logger.info({ ...logCtx, poId, lineCount: lines.length, withoutInvoice, message: "PO inwarding fetched" })
    return NextResponse.json({ po: header, lines, withoutInvoice })
  },
})
