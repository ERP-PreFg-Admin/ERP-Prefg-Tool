import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { sendMfgSelectionEmail } from "@/lib/mailer"
import { poSendMailSchema } from "@/lib/validation/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po-guard"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

// POST /api/purchase-orders/send-mail
// Body: { po_ids: number[] }
//
// User-driven notification send: the selected POs (any mix of status —
// newly raised, cancelled, whatever the user checked in the PO Procurement
// table) are grouped by manufacturer and one consolidated email is sent per
// manufacturer immediately. No approval gate — this doesn't mutate any PO's
// status, it only notifies; status changes (raise/cancel) already happened
// through their own separate flows before this step.
export const POST = withGateway({
  schema: poSendMailSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const poIds = body.po_ids.map(Number)

    // Every id is checked, not just the first: this mails a manufacturer's PO
    // lines out, so one out-of-scope id in the batch is a real disclosure.
    for (const poId of poIds) {
      await assertPoInScope(Number(session.user.id), poId)
    }

    const eventId = makeEventId("PO_SELECTION_EMAIL", "send-batch")
    recordRawEvent("PO_SELECTION_EMAIL", eventId, { poIds })

    const poRows = await query<any>(purchaseOrdersSql.buildSelectByIds(poIds.length), poIds)

    const byMfg = new Map<number, { mfg_code: string; mfg_name: string; lines: { id: number; po_no: string; sku_code: string; sku_name: string | null; qty: number; status: string }[] }>()
    for (const r of poRows) {
      if (!byMfg.has(r.mfg_id)) byMfg.set(r.mfg_id, { mfg_code: r.mfg_code, mfg_name: r.mfg_name, lines: [] })
      byMfg.get(r.mfg_id)!.lines.push({
        id: r.id, po_no: r.po_no, sku_code: r.sku_code, sku_name: r.sku_name, qty: Number(r.qty), status: r.status,
      })
    }

    const results: { mfg_id: number; mfg_name: string; sent: boolean; error?: string }[] = []
    for (const [mfgId, group] of byMfg) {
      try {
        const sent = await sendMfgSelectionEmail(mfgId, group.lines)
        results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, sent })
      } catch (err: any) {
        results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, sent: false, error: err.message })
      }
    }

    const failed = results.filter((r) => !r.sent)
    if (failed.length > 0) {
      recordFailedEvent("PO_SELECTION_EMAIL", eventId, { poIds, results }, `${failed.length} manufacturer(s) failed to send`)
    } else {
      recordProcessedEvent("PO_SELECTION_EMAIL", eventId, { poIds, results })
    }
    logger.info({ ...ctx, eventId, poIds, results, message: "PO selection mail send completed" })

    return NextResponse.json({ ok: true, results })
  },
})
