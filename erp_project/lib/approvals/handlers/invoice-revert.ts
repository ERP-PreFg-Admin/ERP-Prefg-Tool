// INVOICE_REVERT: a requested revert of an inwarded invoice, applied on approval.
// The request wrote nothing, so reject has nothing to undo. See docs/invoice-revert-plan.md §3.

import { ApiError } from "@/lib/gateway/errors"
import { approvalsSql } from "@/lib/queries/approvals"
import { applyInvoiceRevert, assertNoLiveGrn } from "@/lib/invoice/invoice-revert"
import type { ModuleHandler } from "./types"

export const invoiceRevertHandler: ModuleHandler = {
  async setStatus() {},
  async applyAndArchive(conn, entityId, items, approverId, raisedBy) {
    if (raisedBy == null) throw new ApiError(409, "no_requester", "This revert has no recorded requester.")
    // Four-eyes: no admin exception.
    if (raisedBy === approverId) {
      throw new ApiError(403, "self_approval", "You raised this revert, so someone else has to approve it.")
    }
    const reason = items.find((i) => i.field_name === "reason")?.new_value?.trim()
    if (!reason) throw new ApiError(409, "no_reason", "This revert has no reason recorded.")

    const [pending] = await conn.execute(approvalsSql.hasPending, ["INVOICE_REVERT", entityId])
    const approvalId = (pending as { id: number }[])[0]?.id ?? null

    await applyInvoiceRevert(conn, entityId, {
      reason, requestedBy: raisedBy, approvedBy: approverId, approvalId, checkLiveGrn: assertNoLiveGrn,
    })
  },
}
