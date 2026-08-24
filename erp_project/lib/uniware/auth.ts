/**
 * Uniware OAuth. Ported from uniware_sku_export/fetch_sku_details.py, with
 * credentials from env rather than inline.
 *
 *   POST /oauth/token?grant_type=password       → { access_token, refresh_token, expires_in }
 *   GET  /oauth/token?grant_type=refresh_token  → same
 *
 * The asymmetry (POST for one grant, GET for the other) is the API's, not a
 * mistake here.
 */

import {
  UNIWARE_USER_NAME, UNIWARE_PASSWORD, UNIWARE_CLIENT_ID,
} from "@/lib/env"
import { BASE, TIMEOUT_MS, OAUTH_TOKEN_PATH } from "./endpoints"

/** Renew this far ahead of real expiry so a request can't carry a dying token. */
const TOKEN_EXPIRY_BUFFER_S = 300
const DEFAULT_EXPIRES_IN_S = 43199

export type UniwareToken = {
  accessToken: string
  refreshToken?: string
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
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresAt: Date.now() + ttl * 1000,
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

async function refreshAccessToken(refreshToken?: string): Promise<UniwareToken> {
  if (!refreshToken) return getAccessToken()

  // GET, unlike the password grant's POST. The API's asymmetry, not a mistake.
  const qs = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: UNIWARE_CLIENT_ID,
    refresh_token: refreshToken,
  })
  const res = await fetch(`${BASE}${OAUTH_TOKEN_PATH}?${qs}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await res.json().catch(() => ({}))
  if (!data?.access_token) return getAccessToken()
  return tokenFromResponse(data)
}

let cached: UniwareToken | null = null
let inFlight: Promise<UniwareToken> | null = null

export async function getToken(): Promise<UniwareToken> {
  if (cached && Date.now() < cached.expiresAt) return cached
  // Collapse concurrent misses into one round trip.
  if (!inFlight) {
    inFlight = (cached ? refreshAccessToken(cached.refreshToken) : getAccessToken())
      .then((t) => { cached = t; return t })
      .finally(() => { inFlight = null })
  }
  return inFlight
}
