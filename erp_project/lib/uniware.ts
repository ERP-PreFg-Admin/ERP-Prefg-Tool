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
  UNIWARE_CLIENT_ID, UNIWARE_FACILITY, UNIWARE_VENDOR_CODE,
  UNIWARE_SANDBOX, UNIWARE_SANDBOX_FACILITY, UNIWARE_SANDBOX_VENDOR,
} from "@/lib/env"
import logger from "@/lib/logger"
import { uniwareStatusFallback } from "@/lib/uniware-error"

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

/**
 * Which facility a call actually goes to — the ONE place that decides, so every
 * endpoint (create, /po/show, getPurchaseOrderDetails) obeys the same rule and a
 * future one gets it for free.
 *
 * Off prod the resolved facility is deliberately discarded: the sandbox tenant
 * holds no HYP_B2B_GGN or mCaff_Kolkata2, so sending one turns every dev call
 * into "not found" — indistinguishable from a deleted PO. Dev therefore always
 * talks to TEST_FACILITY.
 *
 * On prod the resolved value wins, and landing on the sandbox facility is refused
 * outright rather than sent: a real PO in TEST_FACILITY is invisible to the
 * warehouse that is expecting the goods, and nothing downstream would report it.
 */
export function uniwareFacility(resolved?: string): string {
  if (UNIWARE_SANDBOX) return UNIWARE_SANDBOX_FACILITY

  const facility = resolved?.trim() || UNIWARE_FACILITY
  if (facility === UNIWARE_SANDBOX_FACILITY) {
    throw new Error(
      "Refusing a production Uniware call against the sandbox facility " +
      `(${UNIWARE_SANDBOX_FACILITY}) — set UNIWARE_FACILITY, or map the destination's ` +
      "facility on /masters/warehouses."
    )
  }
  return facility
}

/**
 * The vendor code a pushed PO is raised against. Off prod, always the sandbox
 * vendor — a real code is not configured in the sandbox tenant and would be
 * rejected there anyway.
 *
 * On prod the configured code wins, falling back to the manufacturer's own code.
 * That fallback is known not to work ("Vendor [MFG-002-AJA] is not configured for
 * the facility") and stays only because failing at Uniware with that message is
 * more useful than failing here with a vaguer one. It goes away when the push
 * reads un_code_mfg_sku_wh_map.
 */
export function uniwareVendorCode(mfgCode: string): string {
  if (UNIWARE_SANDBOX) return UNIWARE_SANDBOX_VENDOR
  return UNIWARE_VENDOR_CODE || mfgCode
}

/** Headers every Uniware REST call needs. */
function authHeaders(token: UniwareToken, facility?: string) {
  return { Authorization: `Bearer ${token.accessToken}`, Facility: uniwareFacility(facility) }
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
  facility? : string
  /**
   * Omit to let Uniware assign a code from the facility's own series — that's
   * the number the manufacturer recognises (e.g. GM/2627/PO/2006), and it comes
   * back on the create response.
   *
   * The cost of omitting it is idempotency: Uniware rejects a duplicate code,
   * so supplying our own made a retry provably safe. Without one, a second
   * attempt creates a second PO. See the note in lib/invoice/invoice-inward.ts for
   * where that window actually is.
   */
  purchaseOrderCode?: string
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

/**
 * Collapse repeated itemSKUs into one line each.
 *
 * Uniware allows a SKU once per PO and rejects the second occurrence with
 * "Item type <SKU> already added to purchase order". Our side splits freely: the
 * invoice FIFO allocator turns one invoice line covered by two open POs into two
 * rows of the same SKU, and two invoice lines can carry that SKU as well — so
 * three rows of one SKU reach here from a single ordinary invoice.
 *
 * Quantities sum. The unit price is weighted by quantity so the PO's total value
 * still equals the invoice's, rather than whichever row happened to come first;
 * with the usual case of one price across the rows, that is exactly that price.
 * Rounded to 2dp, the precision money is quoted at anyway.
 */
export function mergeItemsBySku(items: UniwarePoItem[]): UniwarePoItem[] {
  const bySku = new Map<string, UniwarePoItem & { _value: number }>()
  for (const it of items) {
    const qty = Number(it.quantity)
    const price = Number(it.unitPrice ?? 0)
    const seen = bySku.get(it.itemSKU)
    if (!seen) {
      bySku.set(it.itemSKU, { ...it, quantity: qty, _value: qty * price })
      continue
    }
    seen.quantity += qty
    seen._value += qty * price
    // Keep the first non-null for the descriptive fields — they describe the
    // SKU, not the split, so they are the same on every row in practice.
    seen.maxRetailPrice ??= it.maxRetailPrice
    seen.taxTypeCode ??= it.taxTypeCode
  }
  return [...bySku.values()].map(({ _value, ...it }) => ({
    ...it,
    unitPrice: it.quantity > 0 ? Math.round((_value / it.quantity) * 100) / 100 : it.unitPrice,
  }))
}

/** Shape a create payload. Only documented fields are sent — Uniware rejects unknown keys. */
export function buildPurchaseOrder(po: UniwarePoInput) {
  if (!po.vendorCode) throw new Error("vendorCode is required")
  if (!po.items?.length) throw new Error("At least one purchase order item is required")
  po.items.forEach((it, i) => {
    if (!it.itemSKU) throw new Error(`items[${i}].itemSKU is required`)
    if (!(Number(it.quantity) > 0)) throw new Error(`items[${i}].quantity must be > 0`)
    if (it.unitPrice == null) throw new Error(`items[${i}].unitPrice is required`)
  })

  // After validation, so a bad row is still reported against its own index.
  const items = mergeItemsBySku(po.items)

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
    purchaseOrderItems: items.map((it) => ({
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

/**
 * Create the PO and return the code it now carries in Uniware — the assigned
 * one when we didn't supply a code, otherwise the one we sent back unchanged.
 * Throws with Uniware's own error text on a business failure.
 */
export async function createPurchaseOrder(po: UniwarePoInput): Promise<{ purchaseOrderCode: string }> {
  const token = await getToken()
  const payload = buildPurchaseOrder(po)

  const res = await fetch(`${BASE}/services/rest/v1/purchase/purchaseOrder/create`, {
    method: "POST",
    headers: { ...authHeaders(token , po.facility), "Content-Type": "application/json" },
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
  const assigned = data.purchaseOrderCode ?? po.purchaseOrderCode
  if (!assigned) {
    // Nothing to quote to the manufacturer and nothing to reconcile against.
    throw new Error("Uniware accepted the purchase order but returned no purchaseOrderCode")
  }
  return { purchaseOrderCode: assigned }
}

// ── Export jobs ──────────────────────────────────────────────────────────────
// Unicommerce has no endpoint that returns a report directly. Every report is an
// ASYNCHRONOUS EXPORT JOB: create it, poll until the status turns SUCCESSFUL, then
// download the CSV from the filePath the status call hands back.
//
//   POST /services/rest/v1/export/job/create   Facility header REQUIRED -> jobCode
//   POST /services/rest/v1/export/job/status   no Facility header       -> status, filePath
//
// Docs: documentation.unicommerce.com/docs/export-create.html and export-status.html

/** `exportColums` is Unicommerce's own spelling, in their published contract — not
 *  a typo to fix. Correcting it makes the request silently return every column.
 *  tests/unit/uniware-export.test.ts pins it, for the same reason
 *  tests/unit/nanonets-endpoints.test.ts pins that path. */
export const EXPORT_COLUMNS_KEY = "exportColums"

/** The report this module exists to pull. Named exactly as Uniware lists it. */
export const VENDOR_ITEM_EXPORT = "Vendor Item Master"

/** Columns we ask for. Uniware returns display names, not these keys. */
export const VENDOR_ITEM_COLUMNS = [
  "inventory", "vendorCode", "vendorSkuCode", "facility", "itemTypeSku", "itemTypeName",
]

/**
 * Is this failure permanent for this facility?
 *
 * A wrong or inaccessible facility code answers 403 "Illegal Access, facility is
 * required" and will answer it forever — retrying wastes the whole budget. A 500 or
 * a rate limit is worth another go.
 *
 * Deliberately NOT fatal: a rejected column list. That has its own fallback (ask
 * for every column instead), so classifying it as fatal would skip the retry that
 * fixes it.
 */
export function isFatalExportError(status: number, text: string): boolean {
  if (status === 400 || status === 403 || status === 404) return true
  const t = text.toLowerCase()
  if (t.includes("invalid column")) return false
  return ["facility", "not found", "does not exist", "no access", "not authorized", "permission"]
    .some((hint) => t.includes(hint))
}

/** Thrown when retrying cannot help — the caller should skip this facility. */
export class UniwareFatalError extends Error {}

type ExportEnvelope = {
  successful?: boolean
  message?: string
  errors?: { description?: string; message?: string }[]
  warnings?: { description?: string; message?: string }[]
}

/** Uniware's error text, however it chose to report it. */
function envelopeError(data: ExportEnvelope, status: number, fallback: string): string {
  const msgs = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
  return msgs.join("; ") || data.message || `${fallback} (HTTP ${status})`
}

/**
 * Queue an export for ONE facility and return its job code.
 *
 * `columns` empty asks for every column — the documented fallback when a named
 * list is rejected.
 */
export async function createExportJob(
  facility: string,
  jobTypeName = VENDOR_ITEM_EXPORT,
  columns: string[] = VENDOR_ITEM_COLUMNS,
): Promise<string> {
  if (!facility) throw new Error("An export job needs a facility — it is what scopes the report.")
  const token = await getToken()
  const res = await fetch(`${BASE}/services/rest/v1/export/job/create`, {
    method: "POST",
    // ⚠️ The Facility header is set DIRECTLY, not via authHeaders() — because
    // authHeaders() pipes whatever it is given through uniwareFacility(), which
    // replaces it with the sandbox facility off prod. Routing a raw facility through
    // that helper looks like it preserves the value and does not.
    //
    // The pin is right for a WRITE: a purchase order created against the wrong
    // warehouse is destructive and irreversible. An export job is a READ — it
    // produces a report and changes no business data, so there is nothing to protect
    // and pinning it actively breaks the feature: every facility returns the sandbox
    // facility's catalogue, whose vendor codes then match nothing, and the import
    // reports "0 mapped" everywhere while looking successful. That is precisely the
    // bug this comment replaced, so do not "tidy" this back into authHeaders().
    //
    // Omit the header entirely and the call 403s "Illegal Access, facility is required".
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Facility: facility,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      exportJobTypeName: jobTypeName,
      [EXPORT_COLUMNS_KEY]: columns,
      exportFilters: [],
      frequency: "ONETIME",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const raw = await res.text()
  if (!raw.trim()) {
    if (isFatalExportError(res.status, "")) {
      throw new UniwareFatalError(`Uniware returned an empty response (HTTP ${res.status}) for ${facility}`)
    }
    throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)
  }
  let data: ExportEnvelope & { jobCode?: string; exportJobId?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    if (isFatalExportError(res.status, raw)) throw new UniwareFatalError(`${facility}: ${raw.slice(0, 200)}`)
    throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }
  if (!data.successful) {
    const message = envelopeError(data, res.status, "Uniware rejected the export job")
    if (isFatalExportError(res.status, message)) throw new UniwareFatalError(`${facility}: ${message}`)
    throw new Error(message)
  }
  if (!data.jobCode) throw new Error("Uniware accepted the export job but returned no jobCode")
  return data.jobCode
}

export type ExportJobStatus = { status: string; filePath: string | null }

/** One status read. Takes no Facility header — the job code already identifies it. */
export async function getExportJobStatus(jobCode: string): Promise<ExportJobStatus> {
  const token = await getToken()
  const res = await fetch(`${BASE}/services/rest/v1/export/job/status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jobCode }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!raw.trim()) throw new Error(`Empty status response for job ${jobCode} (HTTP ${res.status})`)
  let data: ExportEnvelope & { status?: string; filePath?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Non-JSON status response for job ${jobCode}: ${raw.slice(0, 200)}`)
  }
  if (!data.successful) {
    throw new Error(envelopeError(data, res.status, `Status check failed for job ${jobCode}`))
  }
  return { status: (data.status ?? "").toUpperCase(), filePath: data.filePath ?? null }
}

/**
 * Where a job's status sits, in the only three categories a caller cares about.
 *
 * Uniware documents SUCCESSFUL as the terminal success and does not enumerate the
 * rest, so anything naming a failure is treated as terminal and everything else as
 * still running. Erring that way means an unrecognised in-progress state costs a
 * few more polls, whereas the opposite would abandon a job that was about to
 * finish.
 */
export function classifyJobStatus(status: string): "done" | "failed" | "pending" {
  const s = status.toUpperCase()
  if (s === "SUCCESSFUL" || s === "SUCCESS" || s === "COMPLETE" || s === "COMPLETED") return "done"
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "failed"
  return "pending"
}

/**
 * Poll until the job is ready, then return its download path.
 *
 * `onTick` reports each attempt so a caller can stream progress — an export of a
 * large facility takes tens of seconds and a silent wait reads as a hang.
 */
export async function pollExportJob(
  jobCode: string,
  opts: { attempts?: number; delayMs?: number; onTick?: (attempt: number, status: string) => void } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 40
  const delayMs = opts.delayMs ?? 3000

  for (let i = 1; i <= attempts; i++) {
    const { status, filePath } = await getExportJobStatus(jobCode)
    opts.onTick?.(i, status)
    const verdict = classifyJobStatus(status)
    if (verdict === "failed") throw new Error(`Export job ${jobCode} ended as ${status}`)
    if (verdict === "done") {
      if (!filePath) throw new Error(`Export job ${jobCode} succeeded but returned no filePath`)
      return filePath
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`Export job ${jobCode} was still running after ${attempts} checks`)
}

/**
 * Fetch the report CSV.
 *
 * `filePath` may be absolute or relative to the tenant, so both are handled. The
 * bearer token goes with it: unauthenticated, Uniware answers a login page with
 * HTTP 200 rather than failing, and parsing that as a CSV yields zero rows and a
 * "nothing to import" that is entirely wrong — the same trap fetchPurchaseOrderPdf
 * guards with its PDF magic-byte check.
 */
export async function downloadExportCsv(filePath: string): Promise<string> {
  const token = await getToken()
  const url = /^https?:\/\//i.test(filePath) ? filePath : `${BASE}${filePath.startsWith("/") ? "" : "/"}${filePath}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    // Generous: the largest facility's report is a few MB.
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Downloading the export failed (HTTP ${res.status})`)

  const text = await res.text()
  const head = text.slice(0, 200).toLowerCase()
  if (head.includes("<html") || head.includes("<!doctype")) {
    throw new Error("The export download returned an HTML page, not a CSV — the session was not accepted.")
  }
  if (!text.trim()) throw new Error("The export download was empty.")
  return text
}

/**
 * One line of a vendor's catalogue at one facility: "this vendor supplies this
 * item here".
 *
 * `unitPrice` is MANDATORY per Unicommerce's contract, which is the awkward part —
 * see resolveUnitPrice() in lib/mfg-facility-push.ts for where the number comes
 * from and why a missing one refuses the push rather than sending 0.
 */
export type UniwareVendorItemInput = {
  /** Resolved facility code. Passed through uniwareFacility(), so off prod it is
   *  replaced by the sandbox facility like every other call. */
  facility?: string
  vendorCode: string
  itemTypeSkuCode: string
  /** The manufacturer's own code for the item, if they use one. */
  vendorSkuCode?: string | null
  unitPrice: number
  inventory?: number | null
  priority?: number | null
  enabled?: boolean
}

/**
 * Create or update a vendor item in Unicommerce.
 *
 * The endpoint is `createOrEdit`, which makes it idempotent by design: re-sending
 * the same (vendor, facility, item) updates rather than duplicating. That is what
 * makes the retry path safe — a row whose push outcome we never learned can simply
 * be sent again.
 *
 * Facility-scoped, so the Facility header decides which catalogue the item lands
 * in. It goes through uniwareFacility() rather than being used raw, so off prod it
 * is pinned to the sandbox tenant and cannot touch a real facility.
 *
 * Returns nothing: unlike purchaseOrder/create there is no assigned code to read
 * back. Success is `successful: true` and nothing more.
 */
export async function createVendorItem(item: UniwareVendorItemInput): Promise<void> {
  if (!item.vendorCode) throw new Error("vendorCode is required")
  if (!item.itemTypeSkuCode) throw new Error("itemTypeSkuCode is required")
  if (!Number.isFinite(item.unitPrice)) {
    throw new Error("unitPrice is required and must be a number")
  }

  const token = await getToken()
  const facility = uniwareFacility(item.facility)

  // Only documented fields — Uniware rejects unknown keys.
  const payload = {
    vendorItemType: {
      vendorCode: item.vendorCode,
      itemTypeSkuCode: item.itemTypeSkuCode,
      vendorSkuCode: item.vendorSkuCode ?? undefined,
      inventory: item.inventory ?? undefined,
      unitPrice: item.unitPrice,
      priority: item.priority ?? undefined,
      enabled: item.enabled ?? true,
    },
  }

  const res = await fetch(`${BASE}/services/rest/v1/purchase/vendorItemType/createOrEdit`, {
    method: "POST",
    headers: { ...authHeaders(token, facility), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  // Same three-step read as createPurchaseOrder: Uniware answers HTTP 200 with
  // `successful: false`, so res.ok is not a success check, and an empty or
  // non-JSON body means a Facility/auth problem rather than a business failure.
  const raw = await res.text()
  if (!raw.trim()) {
    throw new Error(`Uniware returned an empty response (HTTP ${res.status}) — check Facility and auth.`)
  }
  let data: {
    successful?: boolean
    message?: string
    errors?: { description?: string; message?: string; fieldName?: string }[]
    warnings?: { description?: string; message?: string }[]
  }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Uniware returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }

  if (!data.successful) {
    const msgs = (data.errors ?? [])
      .map((e) => [e.fieldName, e.description || e.message].filter(Boolean).join(": "))
      .filter(Boolean)
    throw new Error(
      msgs.join("; ") || data.message ||
      `Uniware rejected the vendor item (HTTP ${res.status})`
    )
  }
  for (const w of data.warnings ?? []) {
    logger.warn({
      module: "UNIWARE",
      vendorCode: item.vendorCode,
      itemTypeSkuCode: item.itemTypeSkuCode,
      message: w.description || w.message,
    })
  }
}

/**
 * Download the PO document Unicommerce renders for a code.
 *
 * Not a REST endpoint — this is the web UI's own print view (the page a user
 * reaches from the PO screen), which is why the path sits outside
 * /services/rest/v1. It does accept the OAuth bearer token, and unauthenticated
 * it 302s to /login with an empty body rather than failing outright, so the
 * response is checked for the PDF magic bytes: a login redirect must never be
 * attached to an email as though it were the document.
 */
export async function fetchPurchaseOrderPdf(code: string , facility? : string): Promise<Buffer> {
  const token = await getToken()
  const url = `${BASE}/po/show?code=${encodeURIComponent(code)}&legacy=1`

  const res = await fetch(url, {
    headers: authHeaders(token , facility),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const buf = Buffer.from(await res.arrayBuffer())

  if (!res.ok) {
    throw new Error(`Uniware PO document ${code}: HTTP ${res.status}`)
  }
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    const ct = res.headers.get("content-type") ?? "unknown"
    throw new Error(`Uniware PO document ${code}: expected a PDF, got ${ct} (${buf.length} bytes)`)
  }
  return buf
}

/**
 * The status Unicommerce currently reports for a PO code.
 *
 *   POST /services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails
 *
 * statusCode sits at the TOP level of the response, beside successful/errors —
 * there is NO purchaseOrder wrapper. Reaching through one yields undefined and
 * reads as a PO with no status rather than as a bug, which is why this pulls it
 * flat. Confirmed against the live endpoint; see the FINDINGS block in
 * check_uniware_apis/po_grn.py.
 *
 * Facility-scoped like purchaseOrder/create: the same code asked of the wrong
 * facility is simply not found, so the caller must resolve the right one rather
 * than fall back to a default.
 */
export async function fetchPurchaseOrderStatus(code: string, facility?: string): Promise<string> {
  const token = await getToken()

  const res = await fetch(`${BASE}/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails`, {
    method: "POST",
    headers: { ...authHeaders(token, facility), "Content-Type": "application/json" },
    body: JSON.stringify({ purchaseOrderCode: code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const data = (await res.json().catch(() => ({}))) as {
    successful?: boolean
    statusCode?: string
    errors?: { description?: string; message?: string }[]
  }

  // HTTP 200 with successful:false is how this API reports a business failure —
  // res.ok is not a success check here (see the module header).
  //
  // Which is exactly why the fallback must not say "no purchase order": if we are
  // here on a 401/403 the account was refused, and on a 5xx Uniware broke. Only a
  // 200-with-errors, or a 404, is genuinely about this PO. Saying otherwise sent
  // people hunting for a PO that was there all along.
  if (!data.successful) {
    const msgs = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
    throw new Error(
      msgs.join("; ") || uniwareStatusFallback(`purchase order ${code}`, res.status)
    )
  }
  if (!data.statusCode) throw new Error(`Uniware returned no statusCode for ${code}`)
  return data.statusCode
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
    // "(assigned)" until the response comes back — with no code supplied there
    // is nothing to name the PO by until Uniware answers.
    const label = po.purchaseOrderCode ?? "(assigned)"
    try {
      const res = await createPurchaseOrder(po)
      out.push({ po_no: res.purchaseOrderCode, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const duplicate = /duplicate purchase order code/i.test(message)
      out.push({ po_no: label, ok: duplicate, error: message, duplicate })
      logger[duplicate ? "warn" : "error"]({
        module: "UNIWARE",
        poCode: label,
        err: message,
        message: duplicate ? "PO already existed in Uniware" : "Uniware PO create failed",
      })
    }
  }
  return out
}
