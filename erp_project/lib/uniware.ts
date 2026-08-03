/**
 * Uniware (Unicommerce) — the single place that knows this wire format.
 *
 * Two things live here: OAuth (ported from uniware_sku_export/fetch_sku_details.py,
 * credentials from env rather than inline) and purchase-order creation.
 *
 *   POST /oauth/token?grant_type=password          → { access_token, refresh_token, expires_in }
 *   GET  /oauth/token?grant_type=refresh_token     → same
 *   POST /services/rest/v1/purchase/purchaseOrder/create
 *
 * Two traps this module exists to contain:
 *
 *  1. Uniware answers HTTP 200 with `{successful: false, errors: [...]}` on a
 *     business failure. `res.ok` is not a success check here.
 *  2. purchaseOrder/create is facility-scoped — the Facility header decides
 *     where the PO lands, unlike the facility-agnostic Item Master export.
 */

import {
  UNIWARE_BASE_URL, UNIWARE_USER_NAME, UNIWARE_PASSWORD,
  UNIWARE_CLIENT_ID, UNIWARE_FACILITY,
} from "@/lib/env"
import logger from "@/lib/logger"

const BASE = UNIWARE_BASE_URL.replace(/\/+$/, "")
const TIMEOUT_MS = 30_000
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

  // Credentials go in the query string because that's what this endpoint reads;
  // it ignores a form-encoded body.
  const qs = new URLSearchParams({
    grant_type: "password",
    client_id: UNIWARE_CLIENT_ID,
    username: UNIWARE_USER_NAME,
    password: UNIWARE_PASSWORD,
  })
  const res = await fetch(`${BASE}/oauth/token?${qs}`, {
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
  const res = await fetch(`${BASE}/oauth/token?${qs}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await res.json().catch(() => ({}))
  if (!data?.access_token) return getAccessToken()
  return tokenFromResponse(data)
}

/**
 * Process-wide token, so a burst of PO pushes authenticates once rather than
 * per call. Tokens last ~12h; the buffer above covers clock skew.
 */
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

/** Headers every Uniware REST call needs. */
function authHeaders(token: UniwareToken) {
  return { Authorization: `Bearer ${token.accessToken}`, Facility: UNIWARE_FACILITY }
}

// ── Purchase orders ──────────────────────────────────────────────────────────

export type UniwarePoItem = {
  itemSKU: string
  quantity: number
  unitPrice: number
  maxRetailPrice?: number | null
  discount?: number | null
  discountPercentage?: number | null
  taxTypeCode?: string | null
}

export type UniwarePoInput = {
  /** Our po_no. Uniware enforces uniqueness on it, which is what makes a retry safe. */
  purchaseOrderCode: string
  vendorCode: string
  vendorAgreementName?: string | null
  currencyCode?: string | null
  expiryDate?: string | Date | null
  deliveryDate?: string | Date | null
  logisticCharges?: number | null
  logisticChargesDivisionMethod?: string | null
  items: UniwarePoItem[]
  customFields?: Record<string, string>
}

const iso = (d: string | Date | null | undefined) =>
  d == null ? undefined : d instanceof Date ? d.toISOString() : new Date(d).toISOString()

/**
 * Uniware validates deliveryDate as strictly future — a past one is rejected
 * with "Delivery date should be a future date".
 *
 * That's fine for procurement, but an invoice-driven PO covers goods that have
 * already arrived, so its date is backdated by definition and there is no
 * meaningful future delivery date. Returns undefined in that case: the field is
 * optional, and omitting it is honest where inventing a date would not be.
 * Callers wanting to keep the real date should put it in a custom field.
 */
export function futureDeliveryDate(d: string | Date | null | undefined): string | undefined {
  if (d == null) return undefined
  const at = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(at.getTime())) return undefined
  return at.getTime() > Date.now() ? at.toISOString() : undefined
}

const numOrUndef = (v: unknown) =>
  v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v)

/** Shape a create payload. Only documented fields are sent — Uniware rejects unknown keys. */
export function buildPurchaseOrder(po: UniwarePoInput) {
  if (!po.vendorCode) throw new Error("vendorCode is required")
  if (!po.items?.length) throw new Error("At least one purchase order item is required")
  po.items.forEach((it, i) => {
    if (!it.itemSKU) throw new Error(`items[${i}].itemSKU is required`)
    if (!(Number(it.quantity) > 0)) throw new Error(`items[${i}].quantity must be > 0`)
    if (it.unitPrice == null) throw new Error(`items[${i}].unitPrice is required`)
  })

  const payload = {
    purchaseOrderCode: po.purchaseOrderCode,
    type: "MANUAL", // the only value this endpoint documents
    vendorCode: po.vendorCode,
    vendorAgreementName: po.vendorAgreementName ?? undefined,
    currencyCode: po.currencyCode || "INR",
    expiryDate: iso(po.expiryDate),
    deliveryDate: iso(po.deliveryDate),
    logisticChargesDivisionMethod: po.logisticChargesDivisionMethod ?? undefined,
    logisticCharges: numOrUndef(po.logisticCharges),
    purchaseOrderItems: po.items.map((it) => ({
      itemSKU: it.itemSKU,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      maxRetailPrice: numOrUndef(it.maxRetailPrice),
      discount: numOrUndef(it.discount),
      discountPercentage: numOrUndef(it.discountPercentage),
      taxTypeCode: it.taxTypeCode ?? undefined,
    })),
    customFieldValues: po.customFields
      ? Object.entries(po.customFields).map(([name, value]) => ({ name, value: String(value) }))
      : undefined,
  }

  // Drop undefined so optional fields are absent rather than null — Uniware
  // treats an explicit null as a value and rejects some of them.
  return JSON.parse(JSON.stringify(payload))
}

/** Create the PO. Throws with Uniware's own error text on a business failure. */
export async function createPurchaseOrder(po: UniwarePoInput): Promise<{ purchaseOrderCode: string }> {
  const token = await getToken()
  const payload = buildPurchaseOrder(po)

  const res = await fetch(`${BASE}/services/rest/v1/purchase/purchaseOrder/create`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const raw = await res.text()
  if (!raw.trim()) {
    throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)
  }

  let data: {
    successful?: boolean
    errors?: { description?: string; message?: string }[]
    warnings?: { description?: string; message?: string }[]
    purchaseOrderCode?: string
  }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }

  if (!data.successful) {
    const msgs = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
    throw new Error(msgs.join("; ") || `Uniware rejected the purchase order (HTTP ${res.status})`)
  }
  for (const w of data.warnings ?? []) {
    logger.warn({ module: "UNIWARE", poCode: po.purchaseOrderCode, message: w.description || w.message })
  }
  return { purchaseOrderCode: data.purchaseOrderCode ?? po.purchaseOrderCode }
}

export type UniwarePushResult = {
  po_no: string
  ok: boolean
  error?: string
  /** True when Uniware already had this code — a retry, not a new failure. */
  duplicate?: boolean
}

/**
 * Push several POs, one Uniware PO per inward PO (our model is one PO per SKU).
 *
 * Never throws: the goods are already recorded and physically present, so a
 * Uniware outage must not fail the invoice. Each result is reported instead, and
 * a duplicate is treated as success — Uniware enforces purchaseOrderCode
 * uniqueness, which makes a retry of a partially-pushed batch safe.
 */
export async function pushPurchaseOrders(pos: UniwarePoInput[]): Promise<UniwarePushResult[]> {
  const out: UniwarePushResult[] = []
  for (const po of pos) {
    try {
      await createPurchaseOrder(po)
      out.push({ po_no: po.purchaseOrderCode, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const duplicate = /duplicate purchase order code/i.test(message)
      out.push({ po_no: po.purchaseOrderCode, ok: duplicate, error: message, duplicate })
      logger[duplicate ? "warn" : "error"]({
        module: "UNIWARE",
        poCode: po.purchaseOrderCode,
        err: message,
        message: duplicate ? "PO already existed in Uniware" : "Uniware PO create failed",
      })
    }
  }
  return out
}
