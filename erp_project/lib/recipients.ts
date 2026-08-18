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
  primaryEmail: string | null = null
): { to: string[]; cc: string[] } {
  const to: string[] = []
  const cc: string[] = []
  /** lowercased address → the list it currently sits in. */
  const seen = new Map<string, "to" | "cc">()

  const add = (raw: string | null | undefined, kind: "to" | "cc") => {
    const email = raw?.trim()
    if (!email) return
    const key = email.toLowerCase()
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
  return { to, cc }
}
