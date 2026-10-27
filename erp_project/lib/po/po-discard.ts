// Discarding a Draft PO (approved, never mailed): status → 'discarded', direct, reason required.
// Takes the caller's open transaction, like po-edit.ts, so it is testable under withRollback.

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { discardBlock } from "@/lib/po/po-rules"

type LockedForDiscard = Parameters<typeof discardBlock>[0] & { id: number }

/** Locks the PO, re-checks every discard rule on it, then writes the status and two history rows. */
export async function discardDraftPo(
  conn: PoolConnection,
  poId: number,
  reason: string,
  userId: number,
): Promise<{ po_no: string }> {
  const why = reason.trim()
  if (!why) throw new ApiError(400, "reason_required", "Give a reason for discarding this PO.")

  const [rows] = await conn.execute(purchaseOrdersSql.selectForDiscardLocked, [poId])
  const po = (rows as LockedForDiscard[])[0]
  if (!po) throw new ApiError(404, "not_found", "Purchase order not found")

  const blocked = discardBlock(po)
  if (blocked) throw new ApiError(409, "po_not_discardable", blocked)

  const [res] = await conn.execute<ResultSetHeader>(purchaseOrdersSql.setDiscarded, [po.id])
  if (res.affectedRows !== 1) throw new ApiError(409, "po_not_discardable", `${po.po_no} changed while it was being discarded — reload and try again.`)

  await conn.execute(purchaseOrdersSql.insertPoHistory, [po.id, po.po_no, "update", "status", "raised", "discarded", null, userId])
  await conn.execute(purchaseOrdersSql.insertPoHistory, [po.id, po.po_no, "update", "discard_reason", null, why.slice(0, 500), null, userId])
  return { po_no: po.po_no }
}
