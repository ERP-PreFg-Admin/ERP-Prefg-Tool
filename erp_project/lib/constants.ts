/**
 * Shared status constants for entity and approval records.
 *
 * Use these instead of raw string literals so typos become compile errors
 * and a rename is a single change rather than a grep-and-replace.
 */

/**
 * Branding shown in the top bar. APP_VERSION is the single place the release
 * label lives — bump it here and the header follows.
 */
export const APP_NAME = "House of Pep"
export const APP_VERSION = "PreFG v1.0.0"

export const STATUS = {
  ACTIVE:    "active",
  DRAFT:     "draft",
  IN_REVIEW: "in_review",
  INACTIVE:  "inactive",
  REJECTED:  "rejected",
} as const

export type EntityStatus = typeof STATUS[keyof typeof STATUS]

export const APPROVAL_STATUS = {
  PENDING:  "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const

export type ApprovalStatus = typeof APPROVAL_STATUS[keyof typeof APPROVAL_STATUS]

/**
 * The single mapping from an approval status to its badge variant — every
 * approved/rejected/pending pill in the app (the /approvals queue, history,
 * and the per-entity History table) reads this instead of hand-rolling its
 * own bg/border/dark: classes, which is how "approved" ended up rendered in
 * two different shades of green in different files.
 */
export const APPROVAL_STATUS_VARIANT: Record<ApprovalStatus, "success" | "destructive" | "warning"> = {
  [APPROVAL_STATUS.APPROVED]: "success",
  [APPROVAL_STATUS.REJECTED]: "destructive",
  [APPROVAL_STATUS.PENDING]:  "warning",
}
