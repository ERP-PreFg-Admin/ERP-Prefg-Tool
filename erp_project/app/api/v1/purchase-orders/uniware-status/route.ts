// POST /api/v1/purchase-orders/uniware-status — refresh EVERY mirrored PO's
// status AND its goods receipts from Unicommerce. One button, no arguments.
//
// The grain is one call per Uniware PO, not per inward PO: Uniware holds one PO
// per invoice, so the inward POs sharing a code all read the same answer and
// asking once per row would multiply the round trips for nothing.
//
// ── WHY RECEIPTS RIDE ALONG ─────────────────────────────────────────────────
// getPurchaseOrderDetails returns `inflowReceiptsCount` beside `statusCode`, so
// the status pass ALREADY knows, at no extra cost, which POs have receipts. It
// then walks only those — a small subset on any real tenant, because a PO with
// nothing received is the common case.
//
// Doing it here rather than leaving it to /uniware-grn means one button leaves
// both current. A second button people must remember to press in the right
// order is how "rejected 0" comes to mean "nobody synced", which is exactly the
// confusion the receipt columns exist to remove.
//
// The receipt walk is 1+N calls per PO against the status pass's flat 1, so it
// carries its own budget (GRN_BUDGET) inside the same maxDuration. Whatever the
// budget cuts off is REPORTED and left to /uniware-grn, never silently skipped.
//
// Never throws on an individual PO. A tenant that 500s on one code, or a
// destination nobody has mapped a facility for, must not cost the caller the
// other fifty answers — each outcome is reported instead, the way
// pushPurchaseOrders does it.

export const runtime = "nodejs"
// Sequential Uniware calls, one per mirrored PO. The default cutoff is nowhere
// near enough for a batch.
export const maxDuration = 300

import { NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { uniwareGrn } from "@/lib/queries/uniware-grn"
import { fetchPurchaseOrderStatus, uniwareEnabled } from "@/lib/uniware"
import { requireFacilityForInvoice } from "@/lib/uniware/facility-resolve"
import { syncGrnsForInvoice } from "@/lib/uniware/grn-sync"
import logger from "@/lib/logger"

// ponytail: a flat cap rather than a cursor or a job queue. At one request per PO
// this is the most that fits in maxDuration; when the mirrored set outgrows it,
// the answer is a scheduled sweep, not a bigger number. What it cut off is
// reported, never silently dropped.
const MAX_PER_RUN = 150

/**
 * How many POs this run will walk receipts for, on top of their status.
 *
 * ponytail: a second flat cap, deliberately much smaller than MAX_PER_RUN. A
 * receipt walk is 1+N calls where a status check is 1, so budgeting them the
 * same would let one unusually busy day exhaust maxDuration and lose the
 * statuses too. Overflow is reported as `grnDeferred` and picked up by
 * /uniware-grn, which exists for exactly that.
 */
const GRN_BUDGET = 25

type Row = {
  id: number
  uniware_po_code: string
  destination: string | null
  buyer_gstin: string | null
}

// The facility resolver moved to lib/uniware/facility-resolve.ts when the GRN
// sweep needed the same rule — two implementations of "which facility" would
// eventually disagree about where a PO lives, and the failure is silent: asking
// the wrong facility answers "not found", which would be stored as a real status.

export const POST = withGateway({
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ ctx }) => {
    if (!uniwareEnabled()) {
      throw new ApiError(400, "uniware_unconfigured", "Uniware is not configured on this environment.")
    }

    const rows = await query<Row>(supplierInvoicesSql.selectAllForStatusSync, [MAX_PER_RUN + 1])
    const truncated = rows.length > MAX_PER_RUN
    const batch = truncated ? rows.slice(0, MAX_PER_RUN) : rows

    let synced = 0
    let receipts = 0
    let unmatchedLines = 0
    let grnBudget = GRN_BUDGET
    let grnDeferred = 0
    const failures: { code: string; error: string }[] = []

    for (const row of batch) {
      try {
        // Off prod the facility is pinned to the sandbox anyway, so an unmapped
        // destination is not a reason to skip. On prod it is, and this throws —
        // see requireFacilityForInvoice.
        const facility = await requireFacilityForInvoice(row)
        const { status, grnCount, lines } = await fetchPurchaseOrderStatus(row.uniware_po_code, facility)
        await execute(supplierInvoicesSql.setUniwareStatus, [status, row.id])
        // Free: the same call already carried it, and it is what tells us
        // whether the receipt walk below is worth making at all.
        await execute(uniwareGrn.setGrnCount, [grnCount, row.id])

        // Also free from that call: pending and QC-pass per line, which have no
        // local equivalent. Matched onto our inward PO by SKU. A line whose SKU
        // we never raised simply updates nothing — affectedRows 0 — which is the
        // same finding grn_items_uniware.po_id IS NULL reports for receipts.
        for (const l of lines) {
          await execute(uniwareGrn.setUniwareLineQty, [
            l.pendingQty, l.qcPassQty, row.uniware_po_code, l.sku,
          ])
        }
        synced++

        // Only POs Uniware says have receipts, and only while the budget lasts.
        // A status that stored fine must not be undone by a receipt failure, so
        // this has its own catch — a shape we don't recognise (grn-map.ts throws
        // rather than reading zero) is reported against the PO and the run
        // continues.
        if (grnCount > 0) {
          if (grnBudget > 0) {
            grnBudget--
            try {
              const one = await syncGrnsForInvoice(row, facility)
              receipts += one.receipts
              unmatchedLines += one.unmatchedLines
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err)
              failures.push({ code: `${row.uniware_po_code} (receipts)`, error })
              logger.warn({
                ...ctx, poCode: row.uniware_po_code, err: error,
                message: "Uniware receipt sync failed for one PO",
              })
            }
          } else {
            grnDeferred++
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failures.push({ code: row.uniware_po_code, error })
        logger.warn({
          ...ctx, poCode: row.uniware_po_code, err: error,
          message: "Uniware status sync failed for one PO",
        })
      }
    }

    if (unmatchedLines > 0) {
      // Its own log line: the warehouse received a SKU we never raised a PO for,
      // which no failure count would surface.
      logger.warn({
        ...ctx, unmatchedLines,
        message: "GRN lines matched no inward PO — receipts for SKUs we did not raise",
      })
    }

    return NextResponse.json({
      total: batch.length,
      synced,
      failed: failures.length,
      // Capped at 10: this is a toast, not a report. `failed` is the real count.
      failures: failures.slice(0, 10),
      // Named so the UI can say so — a silent cap reads as "everything is synced".
      truncated,
      limit: MAX_PER_RUN,
      // Receipts, reported separately: "40 synced" says nothing about whether
      // any goods were booked, and grnDeferred is the number /uniware-grn still
      // has to pick up.
      receipts,
      grnDeferred,
      unmatchedLines,
    })
  },
})
