/**
 * Uniware inflow receipts (GRNs) for one mirrored PO.
 *
 * Two calls, and they are shaped DIFFERENTLY despite sharing a namespace:
 *
 *   getInflowReceipts  FLAT     -> { inflowReceiptCodes: string[] }
 *   getInflowReceipt   WRAPPED  -> { inflowReceipt: { ... } }
 *
 * getPurchaseOrderDetails, in the same namespace, is flat. Do not "tidy" these
 * to match each other — the FINDINGS block in check_uniware_apis/po_grn.py pins
 * both shapes, and _receipts() there carries the same warning.
 *
 * Parsing lives in grn-map.ts, which is pure and strict: a key that does not
 * match throws rather than reading as zero. See that file's header for why.
 */

import { getToken } from "./auth"
import { authHeaders } from "./facility"
import { uniwareStatusFallback } from "./errors"
import { BASE, TIMEOUT_MS, GRN_LIST_PATH, GRN_DETAILS_PATH } from "./endpoints"
import { mapInflowReceipt, mapInflowReceiptCodes, type Grn } from "./grn-map"

export type { Grn, GrnItem } from "./grn-map"

type Envelope = {
  successful?: boolean
  errors?: { description?: string; message?: string }[]
}

async function post(path: string, body: unknown, facility: string | undefined, what: string) {
  const token = await getToken()
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(token, facility), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const data = (await res.json().catch(() => ({}))) as Envelope & Record<string, unknown>
  if (!data.successful) {
    const msg = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
    throw new Error(msg.join(", ") || uniwareStatusFallback(what, res.status))
  }
  return data
}

/**
 * Every GRN code against one mirrored PO. An empty list is the normal state of a
 * PO nothing has been received against yet — not an error.
 */
export async function fetchInflowReceiptCodes(
  poCode: string,
  facility?: string
): Promise<string[]> {
  const data = await post(GRN_LIST_PATH, { purchaseOrderCode: poCode }, facility, `inflow receipts for ${poCode}`)
  return mapInflowReceiptCodes(data)
}

/** One GRN, fully. Throws UniwareShapeError if the payload does not match FIELDS. */
export async function fetchInflowReceipt(grnCode: string, facility?: string): Promise<Grn> {
  const data = await post(GRN_DETAILS_PATH, { inflowReceiptCode: grnCode }, facility, `inflow receipt ${grnCode}`)
  // The unwrap belongs here: this is the one place that knows this endpoint is
  // wrapped while its neighbour is flat.
  return mapInflowReceipt(grnCode, data.inflowReceipt)
}

/**
 * Both calls for one PO — the `1 + N` walk.
 *
 * Sequential on purpose: this runs inside a sweep that already fans out over
 * many POs, and the tenant is shared with the warehouse's own traffic.
 */
export async function fetchGrnsForPo(poCode: string, facility?: string): Promise<Grn[]> {
  const codes = await fetchInflowReceiptCodes(poCode, facility)
  const out: Grn[] = []
  for (const code of codes) out.push(await fetchInflowReceipt(code, facility))
  return out
}
