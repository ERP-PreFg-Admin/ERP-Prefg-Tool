/**
 * Unicommerce gatepass endpoints.
 *
 * A gatepass is built in TWO calls, not one: `create` makes an empty document
 * and returns its code, then `addItem` puts one line on it at a time. There is
 * no way to create a populated gatepass in a single request — which is why a
 * failure partway through leaves a real, partly-filled document behind rather
 * than nothing at all. Callers must report that state, never swallow it.
 *
 * Both writes are IRREVERSIBLE from here — there is no delete — and no caller
 * may reach them except through app/api/v1/gatepass/create, which requires an
 * explicit confirmation.
 *
 * A note earned the hard way, 2026-08-28: probing this API's fields by POSTing
 * incomplete bodies is NOT safe. `{"type":…,"partyCode":…,"wsGatePass":{}}`
 * looks obviously invalid and is in fact a valid create — it produced the empty
 * gatepass M/AHM/OG/2627/0013. Unknown fields fail during deserialization, but a
 * known field with an empty value does not. Never probe `create` by trial POST.
 */

import { getToken } from "./auth"
import { envelopeError, type ExportEnvelope } from "./envelope"
import { BASE, TIMEOUT_MS } from "./endpoints"

export const GATEPASS_SEARCH_PATH = "/services/rest/v1/purchase/gatepass/search"
export const GATEPASS_CREATE_PATH = "/services/rest/v1/purchase/gatepass/create"
export const GATEPASS_ADD_ITEM_PATH = "/services/rest/v1/purchase/gatepass/nontraceable/addItem"

export type GatepassSummary = {
  code: string
  type?: string
  statusCode?: string
  created?: number
  toParty?: string
  toPartyCode?: string
  reference?: string
}

/**
 * ISO-8601 with a `Z`, which is the only date form this endpoint accepts.
 *
 * Verified: `"2026-08-01 00:00:00"` is refused with "Can not construct instance
 * of java.util.Date", while `"2026-08-01T00:00:00Z"` works. The Sale Orders
 * export takes epoch millis instead — the two Uniware APIs disagree, so neither
 * date format can be shared between them.
 */
export function uniwareInstant(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

/**
 * Every gatepass at a facility updated since `since`.
 *
 * Facility-scoped by the header, exactly like the export job — and for the same
 * reason it must NOT go through `uniwareFacility()`: this is a READ about the
 * facility the caller named, and pinning it to the sandbox off-prod would report
 * the wrong facility's serials.
 */
export async function searchGatepasses(facility: string, since: Date): Promise<GatepassSummary[]> {
  if (!facility) throw new Error("A gatepass search needs a facility — it is what scopes it.")
  const token = await getToken()

  const res = await fetch(`${BASE}${GATEPASS_SEARCH_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Facility: facility,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updatedSince: uniwareInstant(since) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await res.text()
  let data: ExportEnvelope & { elements?: GatepassSummary[] }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Uniware returned non-JSON for the gatepass search (HTTP ${res.status})`)
  }
  // HTTP 200 with successful:false is how this API reports a business failure,
  // so res.ok is never the success check.
  if (!data.successful) {
    throw new Error(envelopeError(data, res.status, `Gatepass search failed for ${facility}`))
  }
  return data.elements ?? []
}

/** Just the codes, for working out the next serial in a series. */
export async function searchGatepassCodes(facility: string, since: Date): Promise<string[]> {
  return (await searchGatepasses(facility, since)).map((g) => g.code).filter(Boolean)
}

/** Shared POST + envelope handling. Uniware answers HTTP 200 with
 *  `successful:false` for a business failure, so `res.ok` is never the check. */
async function post<T extends ExportEnvelope>(
  path: string, facility: string, body: unknown, what: string,
): Promise<T> {
  if (!facility) throw new Error(`${what} needs a facility — it is what scopes it.`)
  const token = await getToken()

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Facility: facility,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const raw = await res.text()
  let data: T
  try {
    data = JSON.parse(raw) as T
  } catch {
    throw new Error(`Uniware returned non-JSON for ${what} (HTTP ${res.status}): ${raw.slice(0, 200)}`)
  }
  if (!data.successful) throw new Error(envelopeError(data, res.status, `${what} failed at ${facility}`))
  return data
}

/**
 * Create ONE empty gatepass, returning its code. Irreversible.
 *
 * ⚠️ Facility comes straight from the caller and NOT through `uniwareFacility()`,
 * matching the export and the search. Worth stating plainly because it is
 * uncomfortable: an off-prod run writes to a REAL facility, not the sandbox. It
 * is done this way because a gatepass is only meaningful at the facility whose
 * stock is moving, and pinning it to TEST_FACILITY would produce a document
 * nobody can act on while hiding that a write happened. The safety lives in the
 * route instead — explicit confirmation, one facility per request.
 *
 * If `wsGatePass.code` is omitted from the payload, Uniware numbers the document
 * in the facility's own series. Always send a code unless that is intended.
 */
export async function createGatepass(
  facility: string, payload: Record<string, unknown>,
): Promise<string> {
  const data = await post<ExportEnvelope & { gatePassCode?: string | null }>(
    GATEPASS_CREATE_PATH, facility, payload, "creating a gatepass")
  // Success with no code is not a success we can report: the caller would have
  // nothing to look the document up by, and it exists regardless.
  if (!data.gatePassCode) throw new Error("Uniware accepted the gatepass but returned no gatePassCode")
  return data.gatePassCode
}

export type GatepassItemInput = {
  gatePassCode: string
  itemSKU: string
  quantity: number
  /** Uniware's default stock bucket. Not a guess — the only value this flow uses. */
  inventoryType?: string
  unitPrice?: number
  shelfCode?: string
}

/**
 * Add ONE line to an existing gatepass. Irreversible.
 *
 * `itemSKU` must be something Uniware knows as an item. This flow passes a
 * SHIPPING PACKAGE TYPE (`DRY069`), which is only valid if those package types
 * are also registered as SKUs on the tenant — the open question the first real
 * run answers.
 */
export async function addGatepassItem(
  facility: string, item: GatepassItemInput,
): Promise<void> {
  await post(GATEPASS_ADD_ITEM_PATH, facility, {
    gatePassCode: item.gatePassCode,
    itemSKU: item.itemSKU,
    inventoryType: item.inventoryType ?? "GOOD_INVENTORY",
    quantity: item.quantity,
    unitPrice: item.unitPrice ?? 0,
    ...(item.shelfCode ? { shelfCode: item.shelfCode } : {}),
  }, `adding ${item.itemSKU} to ${item.gatePassCode}`)
}
