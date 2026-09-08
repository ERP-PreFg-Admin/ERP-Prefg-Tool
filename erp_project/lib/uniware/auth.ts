/**
 * Uniware OAuth. Ported from uniware_sku_export/fetch_sku_details.py, with
 * credentials from env rather than inline.
 *
 *   POST /oauth/token?grant_type=password  → { access_token, refresh_token, expires_in }
 *
 * ── ONE LIVE TOKEN PER USER, TENANT-WIDE ─────────────────────────────────────
 * This is the fact the whole file is shaped around. Measured on prod 2026-09-08:
 *
 *     password grant           → Ta   Ta → 200
 *     refresh grant            → Tb   Tb → 200,  Ta → 401
 *     password grant again     → Tb   (the same token, expires_in counting down)
 *
 * So the password grant does not mint — it HANDS BACK the user's one current
 * token with its remaining lifetime. Anything that mints a genuinely new one
 * (the refresh grant) silently invalidates whatever everyone else is holding.
 *
 * Three things share the account `erp.prefg@mcaffeine.com`: the prod container,
 * the test container, and uniware_sku_export/fetch_sku_details.py. That is why
 * this module NO LONGER REFRESHES — see refreshAccessToken's grave below — and
 * why the cache is capped well under the token's own expiry.
 */

import {
  UNIWARE_USER_NAME, UNIWARE_PASSWORD, UNIWARE_CLIENT_ID,
} from "@/lib/env"
import { BASE, TIMEOUT_MS, OAUTH_TOKEN_PATH } from "./endpoints"

/** Renew this far ahead of real expiry so a request can't carry a dying token. */
const TOKEN_EXPIRY_BUFFER_S = 300
const DEFAULT_EXPIRES_IN_S = 43199

/**
 * The longest a cached token is trusted, whatever `expires_in` says.
 *
 * The token's own life is ~12h, but per the header note it can be invalidated at
 * any moment by anything else using the account — and nothing tells us. Trusting
 * `expires_in` meant a container could hold a dead token for half a day, with
 * every Uniware call answering "Not authorised — check the Uniware credentials"
 * (uniwareStatusFallback maps both 401 and 403 to that). Prod sat in exactly that
 * state on 2026-09-08 while test worked, because test had refreshed.
 *
 * Re-reading is one GET that returns the SAME token, so the cap costs at most one
 * extra round trip per sync run and bounds the blackout at this window.
 *
 * ponytail: a short cache, not a retry-on-401 wrapper. Every call site builds its
 * own fetch, so a wrapper is a six-file change; this is one line and closes the
 * 12-hour hole. Add the wrapper if a sweep is ever seen to die mid-run.
 */
const MAX_CACHE_MS = 5 * 60_000

// No refreshToken field: the response carries one, but keeping it invited the
// refresh grant back. Nothing may use it — see the note further down.
export type UniwareToken = {
  accessToken: string
  expiresAt: number
}

/** True when Uniware is configured at all — lets callers skip silently. */
export function uniwareEnabled(): boolean {
  return Boolean(BASE && UNIWARE_USER_NAME && UNIWARE_PASSWORD)
}

function tokenFromResponse(data: Record<string, unknown>): UniwareToken {
  if (!data?.access_token) {
    throw new Error(`Uniware auth failed: ${JSON.stringify(data).slice(0, 300)}`)
  }
  const ttl = (Number(data.expires_in) || DEFAULT_EXPIRES_IN_S) - TOKEN_EXPIRY_BUFFER_S
  return {
    accessToken: String(data.access_token),
    // Whichever comes first: the token's own expiry, or MAX_CACHE_MS.
    expiresAt: Date.now() + Math.min(ttl * 1000, MAX_CACHE_MS),
  }
}

async function getAccessToken(): Promise<UniwareToken> {
  if (!uniwareEnabled()) throw new Error("Uniware is not configured (UNIWARE_* env vars)")
  const qs = new URLSearchParams({
    grant_type: "password",
    client_id: UNIWARE_CLIENT_ID,
    username: UNIWARE_USER_NAME,
    password: UNIWARE_PASSWORD,
  })
  const res = await fetch(`${BASE}${OAUTH_TOKEN_PATH}?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return tokenFromResponse(await res.json().catch(() => ({})))
}

// ── refreshAccessToken() USED TO LIVE HERE. DO NOT BRING IT BACK. ────────────
//
// `GET /oauth/token?grant_type=refresh_token` works — it answers 200 with a
// genuinely NEW access_token. That is the problem: minting a new one invalidates
// the token every other holder of this account is using, and there is no
// notification. Prod spent 2026-09-08 answering "Not authorised" on every PO
// because the test container had refreshed and evicted it.
//
// The password grant is strictly better here: it returns the SAME token with its
// remaining lifetime, so every holder converges on one value and nobody evicts
// anybody. It buys nothing to refresh, and it costs an outage.
//
// The real fix is a Uniware API user per environment. Until then this is what
// keeps the two deployments from fighting.

let cached: UniwareToken | null = null
let inFlight: Promise<UniwareToken> | null = null

export async function getToken(): Promise<UniwareToken> {
  if (cached && Date.now() < cached.expiresAt) return cached
  // Collapse concurrent misses into one round trip. Always the password grant —
  // see the note above.
  if (!inFlight) {
    inFlight = getAccessToken()
      .then((t) => { cached = t; return t })
      .finally(() => { inFlight = null })
  }
  return inFlight
}
