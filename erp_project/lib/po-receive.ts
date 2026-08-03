// Booking a goods receipt against a PO.
//
// Extracted from the manual receive route so the invoice-inwarding flow credits
// quantities exactly the same way. Two copies of the tolerance/auto-close rule
// would eventually disagree, and the automated path is the one nobody watches.

import type { PoolConnection } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { poTolerance } from "@/lib/po-rules"

/** Statuses a receipt can be booked against. `punched` is included because the
 *  manual desk flow has always allowed it. */
export const RECEIVABLE = new Set(["raised", "punched", "partially_received"])

type ReceivePoRow = {
  id: number
  po_no: string
  qty: number
  received_qty: number | null
  status: string
}

export type ReceiveResult = {
  po_no: string
  previous_qty: number
  received_qty: number
  status: string
}

/**
 * Credit `qty` to a PO's received_qty and auto-close it once the remainder
 * falls within tolerance. Also writes the history_pos audit row.
 *
 * Takes an already-open connection and does NOT begin/commit/rollback — the
 * route handler owns the transaction. Calling beginTransaction here would
 * implicitly commit the caller's work (MariaDB has no real nesting).
 */
export async function receivePo(
  conn: PoolConnection,
  poId: number,
  qty: number,
  userId: number
): Promise<ReceiveResult> {
  // FOR UPDATE holds the row for the rest of the transaction, so a concurrent
  // receipt on the same PO blocks instead of reading a stale received_qty.
  const [poRows] = await conn.execute(purchaseOrdersSql.selectForReceiveLocked, [poId])
  const po = (poRows as ReceivePoRow[])[0]
  if (!po) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

  if (!RECEIVABLE.has(po.status)) {
    throw new ApiError(
      409,
      "not_receivable",
      `Cannot receive against PO ${po.po_no} — its status is '${po.status}'. Allowed: raised, punched, partially_received.`
    )
  }

  const originalQty = Number(po.qty)
  const receivedQty = Number(po.received_qty ?? 0)
  const remaining   = originalQty - receivedQty
  if (qty > remaining) {
    throw new ApiError(
      400,
      "over_limit",
      `Received qty (${qty}) exceeds the ${remaining} still outstanding on PO ${po.po_no}.`
    )
  }

  await conn.execute(purchaseOrdersSql.incrementReceivedQtyManual, [qty, poId])

  const newReceivedQty = receivedQty + qty
  const newRemaining   = originalQty - newReceivedQty

  // Only 'received' is ever written. 'partially_received' is derived from
  // received_qty by EFFECTIVE_STATUS_EXPR at read time, never stored — storing
  // it would leave a stale value behind once the PO is fully received.
  let newStatus = po.status
  if (newRemaining <= poTolerance(originalQty)) {
    newStatus = "received"
    await conn.execute(purchaseOrdersSql.setStatus, ["received", poId])
  }

  await conn.execute(purchaseOrdersSql.insertPoHistory, [
    poId, po.po_no, "update", "received_qty", String(receivedQty), String(newReceivedQty), null, userId,
  ])

  return { po_no: po.po_no, previous_qty: receivedQty, received_qty: newReceivedQty, status: newStatus }
}
