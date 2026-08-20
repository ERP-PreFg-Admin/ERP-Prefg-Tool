import { NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import {
  sendMfgSelectionEmail, sendSplitPoEmail, partitionSplits, type SelectedPoLine,
} from "@/lib/mail/mailer"
import { poSendMailSchema } from "@/lib/validation/purchase-orders"
import { withGateway } from "@/lib/gateway/with-gateway"
import { assertPoInScope } from "@/lib/po/po-guard"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

// POST /api/v1/purchase-orders/send-mail
// Body: { po_ids: number[] }
//
// User-driven notification send: the selected POs (any mix of status —
// newly raised, cancelled, whatever the user checked in the PO Procurement
// table) are grouped by manufacturer and mailed immediately. No approval gate —
// the stored status is not changed here; raise/cancel already happened through
// their own flows.
//
// Each manufacturer's group becomes ONE consolidated email, plus ONE email per
// raised split PO. A split is a re-issue of demand the manufacturer already holds
// against an order they can be pointed back at, so it gets its own mail and its
// own document rather than a table inside a "PO Update" — see partitionSplits and
// sendSplitPoEmail in lib/mail/mailer.ts.
//
// What this does mutate is email_sent_at, and only for the manufacturers whose
// mail actually went out. PO Tracking shows a raised-but-unmailed PO as Draft
// (DISPLAY_STATUS_EXPR in lib/queries/purchase-orders.ts), so this stamp is
// what flips those rows to Raised — a partly-failed batch must therefore only
// promote the legs that succeeded.
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

    // A PO that has been split isn't a thing to tell a manufacturer about — the
    // children are, each with its own quantity and destination, and they may not
    // even be the same manufacturer. The table disables its checkbox; this is
    // the backstop for anything calling the API directly, and it reports the
    // skip rather than quietly mailing less than was asked for.
    const skippedSplitMasters = poRows.filter((r) => Number(r.child_count) > 0).map((r) => r.po_no)
    const mailable = poRows.filter((r) => Number(r.child_count) === 0)

    const byMfg = new Map<number, { mfg_code: string; mfg_name: string; lines: SelectedPoLine[] }>()
    for (const r of mailable) {
      if (!byMfg.has(r.mfg_id)) byMfg.set(r.mfg_id, { mfg_code: r.mfg_code, mfg_name: r.mfg_name, lines: [] })
      byMfg.get(r.mfg_id)!.lines.push({
        id: r.id, po_no: r.po_no, sku_code: r.sku_code, sku_name: r.sku_name, qty: Number(r.qty),
        status: r.status, reference_po: r.reference_po, destination: r.destination,
      })
    }

    const results: { mfg_id: number; mfg_name: string; po_no?: string; sent: boolean; error?: string }[] = []
    const sentPoIds: number[] = []
    for (const [mfgId, group] of byMfg) {
      // A raised split leaves the consolidated mail entirely and gets its own —
      // see partitionSplits. Each leg is tried and reported separately, so the
      // consolidated one failing can't hold back the splits, or the reverse.
      const { splits, rest } = partitionSplits(group.lines)

      // Skipped when the selection was nothing but splits: a "PO Update" whose
      // only remaining content is the open snapshot is not an update of anything.
      if (rest.length > 0) {
        try {
          const sent = await sendMfgSelectionEmail(mfgId, rest)
          results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, sent })
          if (sent) sentPoIds.push(...rest.map((l) => l.id))
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, sent: false, error })
        }
      }

      // po_no on these results: one manufacturer can now have several legs in a
      // batch, so a partial failure has to name the PO and not just the vendor.
      for (const line of splits) {
        try {
          const sent = await sendSplitPoEmail(mfgId, line)
          results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, po_no: line.po_no, sent })
          if (sent) sentPoIds.push(line.id)
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ mfg_id: mfgId, mfg_name: group.mfg_name, po_no: line.po_no, sent: false, error })
        }
      }
    }

    // Stamped after the sends, never before: a PO that was only attempted is
    // still a draft. Failing to stamp must not fail the request — the mail is
    // already out, and the worst case is a row that still reads Draft and gets
    // re-sent, which the IS NULL guard makes harmless.
    if (sentPoIds.length > 0) {
      try {
        await execute(purchaseOrdersSql.buildMarkEmailSent(sentPoIds.length), sentPoIds)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ ...ctx, eventId, poIds: sentPoIds, error: message, message: "PO mail sent but email_sent_at stamp failed — POs will still show as Draft" })
      }
    }

    const failed = results.filter((r) => !r.sent)
    if (failed.length > 0) {
      recordFailedEvent("PO_SELECTION_EMAIL", eventId, { poIds, results, skippedSplitMasters }, `${failed.length} manufacturer(s) failed to send`)
    } else {
      recordProcessedEvent("PO_SELECTION_EMAIL", eventId, { poIds, results, skippedSplitMasters })
    }
    logger.info({ ...ctx, eventId, poIds, results, skippedSplitMasters, message: "PO selection mail send completed" })

    return NextResponse.json({ ok: true, results, skipped_split_masters: skippedSplitMasters })
  },
})
