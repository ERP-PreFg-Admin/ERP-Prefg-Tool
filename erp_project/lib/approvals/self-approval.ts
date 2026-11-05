// Who may approve their own request: anyone holding a role that is not an Executive one.
// Ops decision 2026-11-05 for PO raise / short close / cancel; the only role-name rule in the app.

import type { PoolConnection } from "mysql2/promise"
import { ApiError } from "@/lib/gateway/errors"
import { auth as authSql } from "@/lib/queries/auth"

/** Pure, for the unit test: Head, Lead, admin and developer may; an Executive-only user may not. */
export function mayApproveOwn(roles: string[]): boolean {
  return roles.some((r) => !r.endsWith("_executive"))
}

/** Throws 403 when the approver raised this request and holds only Executive roles. */
export async function assertSelfApprovalAllowed(
  conn: PoolConnection, raisedBy: number | null | undefined, approverId: number,
): Promise<void> {
  if (raisedBy == null || raisedBy !== approverId) return
  const [rows] = await conn.execute(authSql.getUserRoles, [approverId])
  if (!mayApproveOwn((rows as { role: string }[]).map((r) => r.role))) {
    throw new ApiError(403, "self_approval", "You raised this request, so someone else has to approve it.")
  }
}
