// PO_STATUS: short close and cancel are requested, then applied on approval.
// Both steps re-check the rules on the locked PO and its splits; neither opens a transaction.

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { ApiError } from "@/lib/gateway/errors"
import { approvalsSql } from "@/lib/queries/approvals"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { setTerminalStatus, terminalBlock } from "@/lib/po/po-lifecycle"
import type { DiffItem } from "@/lib/approvals/handlers/types"

export type TerminalStatus = "short_closed" | "cancelled"

export const STATUS_REQUEST_LABEL: Record<TerminalStatus, string> = {
  short_closed: "Short close",
  cancelled: "Cancel",
}

/** Stages a short-close or cancel request. Nothing on the PO changes until approve. */
export async function stagePoStatusRequest(
  conn: PoolConnection,
  poId: number,
  to: TerminalStatus,
  reason: string,
  userId: number,
): Promise<{ approvalId: number; poNo: string }> {
  const { po, blocked } = await terminalBlock(conn, poId, to)
  if (blocked) throw new ApiError(409, to === "short_closed" ? "not_closeable" : "not_cancellable", blocked)

  const [statusPending] = await conn.execute(approvalsSql.hasPending, ["PO_STATUS", poId])
  if ((statusPending as unknown[]).length) {
    throw new ApiError(409, "status_pending", `${po.po_no} already has a short close or cancel awaiting approval.`)
  }
  const [editPending] = await conn.execute(approvalsSql.hasPending, ["PO_EDIT", poId])
  if ((editPending as unknown[]).length) {
    throw new ApiError(409, "edit_pending", `${po.po_no} has an edit awaiting approval — approve or reject it first.`)
  }

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PO_STATUS", poId, "edit"])
  const approvalId = (ar as ResultSetHeader).insertId
  for (const [field, oldVal, newVal] of [["status", po.status, to], ["reason", "", reason]]) {
    await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, oldVal, newVal])
  }
  return { approvalId, poNo: po.po_no }
}

/** Applies an approved request, credited to the requester; the reason goes in the PO history. */
export async function applyPoStatusRequest(
  conn: PoolConnection,
  poId: number,
  items: DiffItem[],
  requestedBy: number,
): Promise<void> {
  const to = items.find((i) => i.field_name === "status")?.new_value
  if (to !== "short_closed" && to !== "cancelled") {
    throw new ApiError(409, "bad_request", "This request names no short close or cancel.")
  }
  const reason = items.find((i) => i.field_name === "reason")?.new_value?.trim() ?? ""
  const po = await setTerminalStatus(conn, poId, to, requestedBy)
  if (reason) {
    await conn.execute(purchaseOrdersSql.insertPoHistory, [po.id, po.po_no, "update", "status_reason", null, reason, null, requestedBy])
  }
}
