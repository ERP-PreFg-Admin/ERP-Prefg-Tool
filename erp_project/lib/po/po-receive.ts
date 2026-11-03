// Booking a goods receipt against a PO.
//
// Extracted from the manual receive route so the invoice-inwarding flow credits
// quantities exactly the same way. Two copies of the receipt rule would
// eventually disagree, and the automated path is the one nobody watches.

import type { PoolConnection } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { isLiveSplit } from "@/lib/po/po-rules"
import { lockPoFamily } from "@/lib/po/po-lifecycle"

/** Statuses a receipt can be booked against. `punched` is included because the
 *  manual desk flow has always allowed it. */
export const RECEIVABLE = new Set(["raised", "punched", "partially_received"])

export type ReceiveResult = {
  po_no: string
  /** The order's SKU — callers raising a matching inward PO reuse it rather
   *  than trusting whatever the invoice printed. */
  sku_code: string | null
  /** The Recipe version this order was raised under. An inward PO settling it
   *  inherits this rather than re-resolving, so goods made under the previous
   *  recipe aren't stamped with the current one. Null on orders predating the
   *  column being written. */
  recipe_id: number | null
  previous_qty: number
  received_qty: number
  status: string
}

/**
 * Credit `qty` to a PO's received_qty and write the history_pos audit row.
 * Closes the PO only when the whole quantity has arrived.
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
  // Parent then split, so a receipt can't race a cancel or close of the same order.
  const { po, splits } = await lockPoFamily(conn, poId)

  if (!RECEIVABLE.has(po.status)) {
    throw new ApiError(
      409,
      "not_receivable",
      `Cannot receive against PO ${po.po_no} — its status is '${po.status}'. Allowed: raised, punched, partially_received.`
    )
  }

  const originalQty = Number(po.qty)
  const receivedQty = Number(po.received_qty ?? 0)

  // Quantity handed to split children isn't the parent's to receive — those
  // goods arrive against the child, which is its own row with its own receipt.
  // Without this a fully-split PO would still accept its whole quantity here
  // and the units would be counted on both rows.
  const allocated = splits.filter(isLiveSplit).reduce((sum, c) => sum + Number(c.qty), 0)

  const remaining = originalQty - receivedQty - allocated
  if (qty > remaining) {
    throw new ApiError(
      400,
      "over_limit",
      allocated > 0
        ? `Received qty (${qty}) exceeds the ${remaining} still outstanding on PO ${po.po_no} — ${allocated} is on its split POs, receive that against them.`
        : `Received qty (${qty}) exceeds the ${remaining} still outstanding on PO ${po.po_no}.`
    )
  }

  await conn.execute(purchaseOrdersSql.incrementReceivedQtyManual, [qty, poId])

  const newReceivedQty = receivedQty + qty

  // Only a receipt covering the whole order closes it; a short one waits for a
  // manual short-close (no tolerance). A split PO is never closed by its own
  // receipts — it reads as received through EFFECTIVE_STATUS_EXPR once the splits arrive.
  let newStatus = po.status
  if (allocated === 0 && newReceivedQty >= originalQty) {
    newStatus = "received"
    await conn.execute(purchaseOrdersSql.setStatus, ["received", poId])
  }

  await conn.execute(purchaseOrdersSql.insertPoHistory, [
    poId, po.po_no, "update", "received_qty", String(receivedQty), String(newReceivedQty), null, userId,
  ])
  // The parent rolls the split's receipt up at read time; this puts it in the parent's history too.
  if (po.reference_po && po.po_type !== "inward") {
    await conn.execute(purchaseOrdersSql.insertPoHistoryByPoNo, [
      "update", "split_received", "", `${qty} via ${po.po_no}`, userId, po.reference_po,
    ])
  }

  return {
    po_no: po.po_no,
    sku_code: po.sku_code,
    recipe_id: po.recipe_id ?? null,
    previous_qty: receivedQty,
    received_qty: newReceivedQty,
    status: newStatus,
  }
}
