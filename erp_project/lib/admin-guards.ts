import type { Session } from "next-auth"
import { ApiError } from "@/lib/gateway/errors"

/**
 * Refuses a permission change that would revoke the caller's own access to
 * /admin.
 *
 * There is no recovery path from the UI: the only screen that can restore
 * /admin access is inside /admin. And unlike other slugs, /admin has no parent
 * to inherit a grant from (lib/permissions.ts' parent-walk stops there), so a
 * downgrade is final until someone runs SQL by hand.
 *
 * Both routes that write permissions call this — the role grid and the per-user
 * overrides — because either one can lock the caller out.
 */
export function assertNotSelfLockout(
  session: Session,
  pageSlug: string,
  accessLevel: string,
  target: { role?: string; userId?: number | string }
) {
  if (pageSlug !== "/admin" || accessLevel === "editor") return

  const affectsSelf =
    (target.role != null && (session.user.roles ?? []).includes(target.role)) ||
    (target.userId != null && String(target.userId) === String(session.user.id))

  if (affectsSelf) {
    throw new ApiError(
      400,
      "self_lockout",
      "That change would remove your own access to Administration. Ask another admin to make it."
    )
  }
}

/**
 * Refuses an entity-scope change to the caller's own row.
 *
 * Same no-recovery-path reasoning as assertNotSelfLockout: an admin who narrows
 * their own manufacturer scope can no longer see the manufacturers they'd need
 * to widen it back, and /admin/data-access itself would start hiding them.
 * Widening is blocked too — self-granting data access shouldn't be a one-click
 * action for the person doing it.
 */
export function assertNotSelfScope(session: Session, targetUserId: number | string) {
  if (String(targetUserId) === String(session.user.id)) {
    throw new ApiError(
      400,
      "self_scope",
      "You can't change your own data access. Ask another admin to make this change."
    )
  }
}
