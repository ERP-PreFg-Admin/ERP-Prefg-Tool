/**
 * The one perishable credential in the document feature: a tenant web cookie.
 *
 * WHY THIS EXISTS AT ALL — everything else about Uniware documents is plain
 * HTTP. Measured against prod on 2026-09-01:
 *
 *     POST pep.unicommerce.com/data/document/auth/details/get
 *       our OAuth bearer  -> HTTP 500 + SPA shell
 *       anonymous         -> HTTP 401 USER_NOT_LOGGED_IN
 *       tenant cookie     -> HTTP 200 { token, checksum }
 *
 * Tenant `pep` signs in through Keycloak realm `google_only` — Google SSO with
 * 2FA and no username/password form — so no service credential we hold can mint.
 * A human runs `python uniware_documents/harvest.py login`, which writes the
 * cookie here. It lasts about ten hours.
 *
 * DO NOT automate the Google sign-in. It risks locking a real Workspace account,
 * and the manual step is thirty seconds a day.
 *
 * SECURITY: the value is a live session for erp.prefg@mcaffeine.com. It is never
 * logged, never returned from an API route, and never sent to a browser. Callers
 * get the cookie only to put it in an outbound Cookie header.
 */

import { query } from "@/lib/db"
import { uniwareDocsSql } from "@/lib/queries/uniware-documents"

export type UniwareWebSession = {
  cookie: string
  obtained_at: Date | string
  expires_at: Date | string | null
  obtained_by: string | null
}

/**
 * Raised when the tenant session is missing or no longer accepted.
 *
 * Its own type because it is the one failure every caller treats as "skip and
 * report", never as an error against the invoice: a stale cookie says nothing
 * about the PO, and it is fixed by a human logging in, not by a retry.
 */
export class UniwareSessionStale extends Error {
  constructor(message = "The Uniware web session has expired. Run `python uniware_documents/harvest.py login` to renew it.") {
    super(message)
    this.name = "UniwareSessionStale"
  }
}

/** The stored cookie, or null when nobody has logged in yet. */
export async function getUniwareWebCookie(): Promise<string | null> {
  const rows = await query<UniwareWebSession>(uniwareDocsSql.selectSession, [])
  const cookie = rows[0]?.cookie?.trim()
  return cookie || null
}

/**
 * The cookie, or throw.
 *
 * Deliberately does NOT check expires_at. That column is advisory — the real
 * test is whether the tenant still accepts it, and a cookie can die early
 * (a sign-out elsewhere) or outlive its stamp. Staleness is detected where it
 * matters, by the mint's response CONTENT. See assertMintable in ./documents.ts.
 */
export async function requireUniwareWebCookie(): Promise<string> {
  const cookie = await getUniwareWebCookie()
  if (!cookie) {
    throw new UniwareSessionStale(
      "No Uniware web session is stored. Run `python uniware_documents/harvest.py login` to create one."
    )
  }
  return cookie
}

/** Session metadata for the UI — everything except the secret itself. */
export async function getUniwareWebSessionInfo(): Promise<
  { present: boolean; obtained_at?: Date | string; expires_at?: Date | string | null; obtained_by?: string | null }
> {
  const rows = await query<UniwareWebSession>(uniwareDocsSql.selectSession, [])
  const row = rows[0]
  if (!row?.cookie) return { present: false }
  return {
    present: true,
    obtained_at: row.obtained_at,
    expires_at: row.expires_at,
    obtained_by: row.obtained_by,
  }
}
