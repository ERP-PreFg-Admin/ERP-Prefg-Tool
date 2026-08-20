// GET /api/v1/purchase-orders/[id]/preview-pdf
// Generates and streams the PO PDF inline so the browser can display it.

export const runtime = "nodejs"

import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { fetchPoData } from "@/lib/mail/mailer"
import { generatePoPdf } from "@/lib/pdf/po-document"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { ApiError } from "@/lib/gateway/errors"
import { poIdParamSchema } from "@/lib/validation/purchase-order-detail"
import logger from "@/lib/logger"
import { recordProcessedEvent, recordFailedEvent , makeEventId, recordRawEvent } from "@/lib/events"

export const GET = withGateway({
  paramsSchema: poIdParamSchema,
  access: { pageSlug: "/po-tracking", level: "viewer" },
  handler: async ({ params, session, ctx }) => {
    const poId = params.id
    // PO ids are sequential integers, so the filtered list isn't a boundary —
    // this refuses a PO belonging to an out-of-scope manufacturer/warehouse.
    await assertPoInScope(Number(session.user.id), poId)
    const eventId = makeEventId("PO_PREVIEW_PDF", "preview", poId)
    recordRawEvent("PO_PREVIEW_PDF", eventId, { poId })
    logger.info({ ...ctx, poId, message: "PO PDF preview requested" })

    const rows = await query<{ po_no: string }>(purchaseOrdersSql.selectForEdit, [poId])
    if (!rows[0]) {
      logger.warn({ ...ctx, poId, message: "PO PDF preview failed — PO not found" })
      // recordFailedEvent("PO_PREVIEW_PDF", eventId, { poId }, "PO not found")
      throw new ApiError(404, "not_found", "PO not found")
    }

    const data = await fetchPoData(poId)
    if (!data) {
      logger.warn({ ...ctx, poId, message: "PO PDF preview failed — PO data unavailable" })
      // recordFailedEvent("PO_PREVIEW_PDF", eventId, { poId }, "PO data unavailable")
      throw new ApiError(404, "not_found", "PO not found")
    }

    const pdf = await generatePoPdf(data)
    logger.info({ ...ctx, poId, po_no: rows[0].po_no, message: "PO PDF preview generated" })
    recordProcessedEvent("PO_PREVIEW_PDF", eventId, { poId, poNo: rows[0].po_no })
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="PO-${rows[0].po_no}.pdf"`,
        "Cache-Control": "no-store",
      },
    })
  },
})
