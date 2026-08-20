// POST /api/v1/purchase-orders/uniware-status — refresh EVERY mirrored PO's
// status from Unicommerce. One button, no arguments.
//
// The grain is one call per Uniware PO, not per inward PO: Uniware holds one PO
// per invoice, so the inward POs sharing a code all read the same answer and
// asking once per row would multiply the round trips for nothing.
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
import { warehouse } from "@/lib/queries/warehouse"
import { panOf } from "@/lib/gstin"
import { UNIWARE_SANDBOX } from "@/lib/env"
import { fetchPurchaseOrderStatus, uniwareEnabled } from "@/lib/uniware"
import logger from "@/lib/logger"

// ponytail: a flat cap rather than a cursor or a job queue. At one request per PO
// this is the most that fits in maxDuration; when the mirrored set outgrows it,
// the answer is a scheduled sweep, not a bigger number. What it cut off is
// reported, never silently dropped.
const MAX_PER_RUN = 150

type Row = {
  id: number
  uniware_po_code: string
  destination: string | null
  buyer_gstin: string | null
}

/**
 * The facility to ask as — the destination site under the entity that was billed,
 * matched on PAN and never on the full GSTIN (Kreative bills Mumbai and ships
 * everywhere). Same resolver the push uses, so the two can't disagree about where
 * a PO lives.
 *
 * ponytail: one query per row rather than a join in the list SQL, so the PAN rule
 * has exactly one implementation. The local round trip is noise beside the
 * Uniware call that follows it.
 */
async function facilityFor(row: Row): Promise<string | undefined> {
  const pan = row.buyer_gstin?.trim() ? panOf(row.buyer_gstin.trim()) : null
  if (!pan) return undefined
  const rows = await query<{ facility_code: string | null }>(
    warehouse.facilityByDestinationAndPan,
    [row.destination, pan]
  )
  return rows[0]?.facility_code?.trim() || undefined
}

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
    const failures: { code: string; error: string }[] = []

    for (const row of batch) {
      try {
        const facility = await facilityFor(row)
        // Off prod the facility is pinned to the sandbox anyway, so an unmapped
        // destination is not a reason to skip. On prod it is: asking the wrong
        // facility answers "not found", which would be stored as a real status.
        if (!facility && !UNIWARE_SANDBOX) {
          throw new Error(
            `'${row.destination}' has no active Uniware facility for the entity billed on this invoice. ` +
            "Set it on /masters/warehouses."
          )
        }
        const status = await fetchPurchaseOrderStatus(row.uniware_po_code, facility)
        await execute(supplierInvoicesSql.setUniwareStatus, [status, row.id])
        synced++
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failures.push({ code: row.uniware_po_code, error })
        logger.warn({
          ...ctx, poCode: row.uniware_po_code, err: error,
          message: "Uniware status sync failed for one PO",
        })
      }
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
    })
  },
})
