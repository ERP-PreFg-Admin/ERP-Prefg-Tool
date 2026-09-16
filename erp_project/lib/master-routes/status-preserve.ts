import { STATUS } from "@/lib/constants"

/**
 * Keep a non-active status alive across an approval.
 *
 * Submitting an edit sets the record to `in_review`, which overwrites whatever
 * status it had. On approval the handler can only read the diff — so if the
 * submitter didn't change the status, nothing remembers it was `inactive` and
 * the record silently reactivates.
 *
 * Recording it as an item costs a no-op row on the approver's diff, and only for
 * records that are already non-active.
 */
export function withStatusPreserved(
  diff: [string, string][],
  proposed: Record<string, string>,
  currentStatus: string | null | undefined,
): [string, string][] {
  if (currentStatus === STATUS.ACTIVE || !currentStatus) return diff
  if (diff.some(([field]) => field === "status")) return diff
  return [...diff, ["status", proposed.status]]
}
