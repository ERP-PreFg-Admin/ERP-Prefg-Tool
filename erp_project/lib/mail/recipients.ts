/**
 * Turning entity_emails rows into a To list and a CC list.
 *
 * Its own module, not part of lib/mailer.ts, because that file imports
 * nodemailer and lib/env — a credential-free unit test cannot load it. Same
 * reason lib/invoice-merge.ts is split out of lib/invoice-inward.ts.
 */

export type RecipientRow = {
  email: string
  /** NULL / anything unrecognised is a To — the column's default, and how every
   *  row behaved before To/CC existed. */
  recipient_type?: string | null
}

/**
 * Split addresses into To and CC, deduplicated case-insensitively.
 *
 * `primaryEmail` (the manufacturer's own address off master_mfgs) is always a
 * To and always first — it is the party being written to, not copied.
 *
 * **To wins.** An address listed both ways appears once, in To. Sending the same
 * person a To and a CC copy of one mail is a duplicate in their inbox, and the
 * one thing worse than not being copied is being copied twice.
 */
export function splitRecipients(
  rows: RecipientRow[],
  primaryEmail: string | null = null,
  /**
   * Lowercased addresses SES has told us not to send to again — permanent
   * bounces and complaints, from `email_suppressions`.
   *
   * Filtered here rather than at the call sites because this is the one place
   * every recipient passes through, and because it has to apply to **CC as well
   * as To**. Suppressing only the To list would still copy a dead address on
   * every mail, which SES counts as a repeat send to a known-bad recipient and
   * which damages the domain's reputation exactly as a To would.
   *
   * `suppressed` is also applied to `primaryEmail`. That address comes from
   * details_mfg.email and has no entity_emails row, so it is both un-suppressible
   * by any per-row flag and the most likely to be stale.
   */
  suppressed: ReadonlySet<string> = new Set()
): { to: string[]; cc: string[]; dropped: string[] } {
  const to: string[] = []
  const cc: string[] = []
  const dropped: string[] = []
  /** lowercased address → the list it currently sits in. */
  const seen = new Map<string, "to" | "cc">()

  const add = (raw: string | null | undefined, kind: "to" | "cc") => {
    const email = raw?.trim()
    if (!email) return
    const key = email.toLowerCase()

    // Checked before the dedupe bookkeeping, so a suppressed address can never
    // occupy a slot in `seen` and shadow a later legitimate one.
    if (suppressed.has(key)) {
      if (!dropped.includes(email)) dropped.push(email)
      return
    }

    const already = seen.get(key)
    if (already === kind || already === "to") return
    if (already === "cc") {
      // Promote: this address is also a To, so drop the CC copy.
      const i = cc.findIndex((e) => e.toLowerCase() === key)
      if (i >= 0) cc.splice(i, 1)
    }
    seen.set(key, kind)
    ;(kind === "to" ? to : cc).push(email)
  }

  add(primaryEmail, "to")
  for (const r of rows) add(r.email, r.recipient_type === "cc" ? "cc" : "to")
  // `dropped` is returned rather than swallowed so the caller can log which
  // addresses were skipped. A silently shrinking recipient list is how the
  // original problem — mail nobody receives — comes back in a new form.
  return { to, cc, dropped }
}
