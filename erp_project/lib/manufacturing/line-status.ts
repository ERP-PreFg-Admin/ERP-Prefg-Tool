/**
 * The two status rules for a manufacturer's recipe line (master_recipe_mfg),
 * kept pure so a unit test can cover them without a DB — the same reason
 * lib/po/po-rules.ts and lib/masters/variant-rm-lock.ts sit apart from their
 * routes.
 *
 * 1. effective_to is DERIVED from status, never set independently:
 *      → active                        open-ended  (NULL)
 *      → inactive / discontinued       the day it ended (today)
 *    A line already deactivated keeps its end date across unrelated edits — the
 *    date marks when it stopped, not when it was last touched.
 *
 * 2. Re-activating a deactivated line (inactive/discontinued → active) is the
 *    one transition that flips costing and PO-raising back on, so it goes
 *    through approval rather than a direct write. Everything else is direct.
 */

export type MfgLineStatus = "active" | "discontinued" | "inactive"

/** True for the one transition that must be approved, not written directly. */
export function isActivation(prior: MfgLineStatus, next: MfgLineStatus): boolean {
  return next === "active" && (prior === "inactive" || prior === "discontinued")
}

/**
 * The effective_to a line should carry after an UPDATE, given its stored state.
 * `today` is injected (IST date string) so this stays pure.
 */
export function deriveEffectiveTo(args: {
  prior: MfgLineStatus
  next: MfgLineStatus
  priorEffectiveTo: string | null
  today: string
}): string | null {
  if (args.next === "active") return null           // open-ended
  if (args.prior === "active") return args.today    // just deactivated now
  return args.priorEffectiveTo ?? args.today        // already deactivated: keep, or stamp legacy nulls
}

/** effective_to for a newly CREATED line — active is open-ended, anything else ended today. */
export function createEffectiveTo(status: MfgLineStatus, today: string): string | null {
  return status === "active" ? null : today
}
