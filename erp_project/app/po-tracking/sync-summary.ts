/**
 * What the Sync Uniware run says afterwards.
 *
 * Extracted from SyncUniwareButton.tsx so it can be unit-tested without React —
 * the same reason lib/po/po-rules.ts sits outside the routes that use it.
 *
 * The old version returned one string, everything `·`-joined:
 *
 *   0 of 5 synced · 5 failed · first: 0020 — Uniware returned no purchase order 0020 (HTTP 403)
 *
 * Three faults in one line. The counts and the reason are different kinds of
 * information rendered at the same weight; the PO code appears twice, because the
 * caller prefixed it and the thrown message already embedded it; and "first:"
 * implies five different problems when five identical 403s are one problem.
 */

import { uniwareErrorReasons } from "@/lib/uniware/errors"

export type SyncFailure = { code: string; error: string }

export type SyncResult = {
  total: number
  synced: number
  failed: number
  failures?: SyncFailure[]
  truncated?: boolean
  limit?: number
  /* ── Goods receipts, pulled by the same run ───────────────────────────────
   * The status pass learns inflowReceiptsCount for free and walks the receipts
   * of the POs that have any, within its own budget. `grnDeferred` is what that
   * budget cut off — still to be picked up by /uniware-grn. */
  receipts?: number
  grnDeferred?: number
  unmatchedLines?: number
}

export type SyncSummary = {
  /** Counts only. Never styled as an error — "0 of 5 synced" is a fact. */
  counts: string
  /** Distinct reasons, already cleaned. Rendered as its own line. */
  reasons: string[]
  /** Whether anything actually failed, for the caller's styling. */
  failed: boolean
}

/** At most this many reasons before collapsing into "+N more". */
const MAX_SHOWN = 3

export function summariseSync(r: SyncResult): SyncSummary {
  if (r.total === 0) {
    return { counts: "No mirrored POs to sync yet.", reasons: [], failed: false }
  }

  const parts = [`${r.synced} of ${r.total} synced`]
  if (r.failed) parts.push(`${r.failed} failed`)
  // Receipts only when there were some. "0 goods receipts" on every run would
  // be noise on a tenant where most POs never have one.
  if (r.receipts) parts.push(`${r.receipts} goods receipt${r.receipts === 1 ? "" : "s"}`)
  // Never let a cap pass unmentioned: "40 of 40 synced" would otherwise read as
  // the whole list when it was the newest 40 of 300.
  if (r.truncated) parts.push(`only the newest ${r.limit} were checked`)
  // Deferred is not a failure — it is work the receipt budget postponed, and
  // saying so is what stops "synced" reading as "receipts are current".
  if (r.grnDeferred) parts.push(`${r.grnDeferred} still awaiting a receipt pull`)

  const reasons = failureReasons(r.failures ?? [], r.failed)
  // A finding, not an error: the warehouse booked a SKU we never ordered. It
  // would otherwise show up nowhere a human looks.
  if (r.unmatchedLines) {
    reasons.push(`${r.unmatchedLines} receipt line(s) matched no purchase order of ours`)
  }

  return {
    counts: parts.join(" · "),
    reasons,
    failed: r.failed > 0,
  }
}

/** The document sweep's result shape — see lib/uniware/document-sync.ts. */
export type DocSyncResult = {
  total: number
  pulled: number
  pushed: number
  failed: number
  failures?: SyncFailure[]
  sessionStale?: boolean
  truncated?: boolean
  limit?: number
  disabled?: boolean
}

/**
 * What the Sync Documents run says afterwards. Kept beside summariseSync because
 * it renders into the same SyncSummary shape and reuses failureReasons.
 */
export function summariseDocSync(r: DocSyncResult): SyncSummary {
  // Off dev the feature is inert by design — say so plainly, not as a failure.
  if (r.disabled) {
    return { counts: "Document sync is limited to the test facility for now.", reasons: [], failed: false }
  }
  // The one failure the user can actually fix, so it gets its own message.
  if (r.sessionStale) {
    return {
      counts: "Uniware session expired.",
      reasons: ["Open Uniware and click the ERP Uniware Session extension, then run this again."],
      failed: true,
    }
  }
  if (r.total === 0) {
    return { counts: "No mirrored invoices to sync yet.", reasons: [], failed: false }
  }

  const parts = [`${r.pulled} pulled`, `${r.pushed} pushed`]
  if (r.failed) parts.push(`${r.failed} failed`)
  if (r.truncated) parts.push(`only the newest ${r.limit} were checked`)

  return {
    counts: parts.join(" · "),
    reasons: failureReasons(r.failures ?? [], r.failed),
    failed: r.failed > 0,
  }
}

/**
 * One entry per DISTINCT reason, not per failure.
 *
 * Five POs refused by one expired token is one sentence, not five — and not
 * "first: …" either, which invites someone to fix one PO when nothing is wrong
 * with any of them.
 */
function failureReasons(failures: SyncFailure[], failed: number): string[] {
  if (failures.length === 0) return []

  // Group codes by the reason they share, preserving first-seen order.
  const byReason = new Map<string, string[]>()
  for (const f of failures) {
    const reason = uniwareErrorReasons(f.error).join(" · ") || "No reason given."
    const codes = byReason.get(reason)
    if (codes) codes.push(f.code)
    else byReason.set(reason, [f.code])
  }

  // Every failure, same cause: say the cause once and drop the codes entirely.
  // They add nothing — the table already shows which rows are unsynced.
  if (byReason.size === 1 && failures.length > 1) {
    const [reason] = [...byReason.keys()]
    const all = failures.length >= failed
    return [`${all ? "All" : failures.length} failed: ${reason}`]
  }

  const out: string[] = []
  for (const [reason, codes] of byReason) {
    if (out.length === MAX_SHOWN) {
      out.push(`+${byReason.size - MAX_SHOWN} more`)
      break
    }
    // Only label with the code when the reason doesn't already name it — the
    // double-code in the old output came from prefixing unconditionally.
    const label = codes.join(", ")
    out.push(reason.includes(codes[0]) ? reason : `${label}: ${reason}`)
  }
  return out
}
