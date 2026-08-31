/**
 * "What POs exist at this facility in the last N days, and what has been
 * received against them?" — a read-only window onto the Uniware tenant.
 *
 * Nothing here touches our database. It exists because the ERP's own views only
 * show POs WE mirrored, and several questions need the tenant's own answer:
 * confirming a push landed, reading a facility's live PO-code series, and —
 * right now — finding a PO that actually has a GRN so the receipt shape can be
 * confirmed (see the FINDINGS block in check_uniware_apis/po_grn.py, which this
 * is the in-app equivalent of).
 *
 * ── THIS MODULE DELIBERATELY BYPASSES THE SANDBOX FACILITY PIN ───────────────
 * Every other Uniware call goes through authHeaders() -> uniwareFacility(),
 * which swaps in TEST_FACILITY off prod so a dev shell can never address a real
 * warehouse. That pin is right for those paths and MUST NOT be removed from
 * them: they all WRITE — createPurchaseOrder, createVendorItem — and a write
 * aimed at the wrong facility is not recoverable.
 *
 * This module only ever POSTs to two read endpoints (getPurchaseOrders,
 * getPurchaseOrderDetails) plus the two GRN reads. Nothing it can do changes
 * anything in the tenant. Under the pin the facility box was inert off prod —
 * you asked for MUM_WAREHOUSE2 and TEST_FACILITY answered — which made the
 * screen useless for its actual job: finding a PO that has a real goods receipt.
 *
 * So headers are built here, with the facility exactly as asked.
 * DO NOT copy explorerHeaders() into anything that writes.
 */

import { getToken } from "./auth"
import type { UniwareToken } from "./auth"
import { uniwareStatusFallback } from "./errors"
import { BASE, TIMEOUT_MS, PO_LIST_PATH, PO_DETAILS_PATH, GRN_LIST_PATH, GRN_DETAILS_PATH } from "./endpoints"
import { UNIWARE_FACILITY } from "@/lib/env"

/**
 * The facility header, UNPINNED — what the caller asked for, falling back to the
 * configured default when the box is left blank.
 *
 * Read-only paths only. See the module header.
 */
function explorerHeaders(token: UniwareToken, facility?: string) {
  return {
    Authorization: `Bearer ${token.accessToken}`,
    Facility: facility?.trim() || UNIWARE_FACILITY,
  }
}

/**
 * Uniware's timestamp shape: milliseconds and a literal Z, not +00:00.
 * toISOString() already produces exactly this.
 */
const isoMillis = (d: Date) => d.toISOString()

async function call(path: string, body: unknown, facility: string | undefined, what: string) {
  const token = await getToken()
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...explorerHeaders(token, facility), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    successful?: boolean
    errors?: { description?: string; message?: string }[]
  }
  if (!data.successful) {
    const msg = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
    throw new Error(msg.join(", ") || uniwareStatusFallback(what, res.status))
  }
  return data
}

export type ExploredPo = {
  code: string
  status: string | null
  /** Uniware's `created`, already converted from epoch MILLISECONDS. */
  createdAt: string | null
  /** inflowReceiptsCount — 0 means nothing received, however approved it looks. */
  grnCount: number
  lineCount: number
  /* Per-line quantities, summed. All four come off getPurchaseOrderDetails, so
   * a PO's receipt position is readable WITHOUT fetching any GRN — this is the
   * cheapest answer to "did anything actually arrive, and was any of it
   * rejected", one call per PO instead of 1+N. */
  qty: number
  pendingQty: number
  receivedQty: number
  qcPassQty: number
  rejectedQty: number
  /** Distinct SKUs on the PO, capped for display. */
  skus: string[]
  vendorCode: string | null
  /** Set instead of the numbers when the per-PO detail call failed. */
  error?: string
}

export type ExploreResult = {
  /** What the facility box asked for. */
  requestedFacility: string
  /** What actually answered — the same, or UNIWARE_FACILITY when left blank. */
  effectiveFacility: string
  days: number
  from: string
  to: string
  /** Codes the window returned, before the detail cap. */
  totalCodes: number
  /** True when totalCodes exceeded `limit` and only the first `limit` were walked. */
  truncated: boolean
  limit: number
  pos: ExploredPo[]
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const sumBy = (items: Record<string, unknown>[], key: string) =>
  items.reduce((t, i) => t + num(i[key]), 0)

/**
 * One PO's detail. FLAT response — statusCode, inflowReceiptsCount and
 * purchaseOrderItems sit beside `successful`, unlike getInflowReceipt next door
 * which wraps. Do not normalise the two.
 */
async function detail(code: string, facility: string | undefined): Promise<ExploredPo> {
  try {
    const d = await call(PO_DETAILS_PATH, { purchaseOrderCode: code }, facility, `purchase order ${code}`)
    const items = (Array.isArray(d.purchaseOrderItems) ? d.purchaseOrderItems : []) as Record<string, unknown>[]

    // `created` is epoch MILLISECONDS, not the ISO string the docs publish.
    // Treating it as ISO yields nonsense rather than an error.
    const createdMs = Number(d.created)
    const createdAt = Number.isFinite(createdMs) && createdMs > 0
      ? new Date(createdMs).toISOString()
      : null

    const skus = [...new Set(
      items.map((i) => String(i.itemSKU ?? i.itemTypeSKU ?? "")).filter(Boolean)
    )]

    return {
      code,
      status: (d.statusCode as string) ?? null,
      createdAt,
      grnCount: num(d.inflowReceiptsCount),
      lineCount: items.length,
      qty: sumBy(items, "quantity"),
      pendingQty: sumBy(items, "pendingQuantity"),
      receivedQty: sumBy(items, "receivedQuantity"),
      qcPassQty: sumBy(items, "qcPassQuantity"),
      rejectedQty: sumBy(items, "rejectedQuantity"),
      skus: skus.slice(0, 6),
      vendorCode: (d.vendorCode as string) ?? null,
    }
  } catch (err) {
    // Never lose the other forty-nine answers to one bad PO — same contract as
    // the syncs. The row still lists, carrying its error.
    return {
      code, status: null, createdAt: null, grnCount: 0, lineCount: 0,
      qty: 0, pendingQty: 0, receivedQty: 0, qcPassQty: 0, rejectedQty: 0,
      skus: [], vendorCode: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * POs created at one facility in the last `days`, with each one's status,
 * quantities and GRN count.
 *
 * `limit` caps the per-PO detail calls, not the list: the window itself can
 * return thousands (2,507 over 300 days at one facility), and this is one HTTP
 * request's budget. What it cut off is reported rather than silently dropped.
 */
export async function explorePurchaseOrders(opts: {
  facility: string
  days: number
  limit: number
}): Promise<ExploreResult> {
  const requested = opts.facility.trim()
  const effective = requested || UNIWARE_FACILITY

  const to = new Date()
  const from = new Date(to.getTime() - opts.days * 24 * 60 * 60 * 1000)

  const list = await call(
    PO_LIST_PATH,
    { createdBetween: { start: isoMillis(from), end: isoMillis(to) } },
    requested || undefined,
    `purchase orders at ${effective}`
  )

  const codes = (Array.isArray(list.purchaseOrderCodes) ? list.purchaseOrderCodes : [])
    .map((c) => (c == null ? "" : String(c).trim()))
    .filter(Boolean)

  const truncated = codes.length > opts.limit
  const walk = truncated ? codes.slice(0, opts.limit) : codes

  // Sequential: this is a shared tenant the warehouse is also using, and the
  // point of the cap is to keep one click's cost predictable.
  const pos: ExploredPo[] = []
  for (const code of walk) pos.push(await detail(code, requested || undefined))

  // Newest first. The endpoint has no sort parameter, so it has to happen here;
  // a PO whose `created` did not parse sorts last rather than jumping to 1970.
  pos.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))

  return {
    requestedFacility: requested,
    effectiveFacility: effective,
    days: opts.days,
    from: from.toISOString(),
    to: to.toISOString(),
    totalCodes: codes.length,
    truncated,
    limit: opts.limit,
    pos,
  }
}

export type RawGrn = {
  code: string
  /** Every top-level key the receipt really returned, so a shape change is visible. */
  headerKeys: string[]
  /** Every key on the first line item — the field names Gate 0 is waiting on. */
  itemKeys: string[]
  header: Record<string, unknown>
  items: Record<string, unknown>[]
}

/**
 * Every GRN on one PO, UNMAPPED.
 *
 * Deliberately not routed through grn-map.ts: that mapper is strict and throws
 * on a field name it does not recognise, which is right for the sync and exactly
 * wrong here — this is the screen you open to LEARN the field names. It reports
 * what came back rather than judging it.
 *
 * getInflowReceipt is WRAPPED in "inflowReceipt" while getPurchaseOrderDetails
 * beside it is flat. The `?? data` fallback means a tenant that ever stops
 * wrapping still shows something instead of an empty card.
 */
export async function exploreGrns(poCode: string, facility?: string): Promise<RawGrn[]> {
  const list = await call(
    GRN_LIST_PATH, { purchaseOrderCode: poCode }, facility, `inflow receipts for ${poCode}`
  )
  const codes = (Array.isArray(list.inflowReceiptCodes) ? list.inflowReceiptCodes : [])
    .map((c) => (c == null ? "" : String(c).trim()))
    .filter(Boolean)

  const out: RawGrn[] = []
  for (const code of codes) {
    const data = await call(
      GRN_DETAILS_PATH, { inflowReceiptCode: code }, facility, `inflow receipt ${code}`
    )
    const receipt = ((data.inflowReceipt ?? data) as Record<string, unknown>) ?? {}
    const items = (Array.isArray(receipt.inflowReceiptItems) ? receipt.inflowReceiptItems : []) as Record<string, unknown>[]
    const { inflowReceiptItems: _drop, ...header } = receipt
    void _drop
    out.push({
      code,
      headerKeys: Object.keys(receipt),
      itemKeys: items[0] ? Object.keys(items[0]) : [],
      header,
      items,
    })
  }
  return out
}

export type RawPoDetail = {
  code: string
  /** Every top-level key the response really returned. */
  headerKeys: string[]
  /** Every key on the first line item. */
  itemKeys: string[]
  /** Header fields, minus the envelope noise and the items array. */
  header: Record<string, unknown>
  items: Record<string, unknown>[]
}

/**
 * One PO in full, UNMAPPED — every field Uniware holds, as it names them.
 *
 * The summary row in the list is a reading of this; this is the source. It
 * matters because getPurchaseOrderDetails carries far more than the list shows,
 * including the per-line receipt numbers the ERP has nowhere else:
 *
 *   quantity  pendingQuantity  receivedQuantity  qcPassQuantity  rejectedQuantity
 *
 * — so a PO's accepted/rejected position is readable HERE even when no GRN has
 * been fetched. Also carries the tax breakdown, batchGroupCode, shelfLife and
 * the vendor address block.
 *
 * `successful` / `message` / `errors` / `warnings` are dropped: they describe
 * the CALL, not the PO, and call() has already acted on them.
 */
export async function explorePoDetail(code: string, facility?: string): Promise<RawPoDetail> {
  const data = await call(
    PO_DETAILS_PATH, { purchaseOrderCode: code }, facility, `purchase order ${code}`
  )
  const items = (Array.isArray(data.purchaseOrderItems) ? data.purchaseOrderItems : []) as Record<string, unknown>[]

  const header: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === "purchaseOrderItems") continue
    if (k === "successful" || k === "message" || k === "errors" || k === "warnings") continue
    header[k] = v
  }

  return {
    code,
    headerKeys: Object.keys(data),
    itemKeys: items[0] ? Object.keys(items[0]) : [],
    header,
    items,
  }
}
