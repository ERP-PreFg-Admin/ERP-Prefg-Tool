import { UNIWARE_BASE_URL } from "@/lib/env"

/** Trailing slashes stripped so `${BASE}${PATH}` never doubles them. */
export const BASE = UNIWARE_BASE_URL.replace(/\/+$/, "")

/** Transport timeout for every call except the export download, which is a few
 *  MB and sets its own. */
export const TIMEOUT_MS = 30_000

export const OAUTH_TOKEN_PATH = "/oauth/token"

export const PO_CREATE_PATH = "/services/rest/v1/purchase/purchaseOrder/create"
export const PO_DETAILS_PATH = "/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails"

/**
 * Inflow receipts — GRNs. Two calls, because the list endpoint returns bare
 * codes and every field worth having (received qty, rejectedQuantity, batch,
 * expiry) lives on the per-receipt fetch.
 *
 * The two are shaped DIFFERENTLY despite sharing a namespace: getInflowReceipts
 * is flat (`inflowReceiptCodes`), getInflowReceipt is WRAPPED (`inflowReceipt`).
 * Do not normalise them — see the FINDINGS block in
 * check_uniware_apis/po_grn.py, which pins both shapes.
 */
export const GRN_LIST_PATH = "/services/rest/v1/purchase/inflowReceipt/getInflowReceipts"
export const GRN_DETAILS_PATH = "/services/rest/v1/purchase/inflowReceipt/getInflowReceipt"

/**
 * POs at a facility, by created window. Returns `purchaseOrderCodes` — bare
 * strings, so every detail needs the per-PO call after it.
 *
 * There is NO sort parameter, so a date window is the only way to ask for "the
 * latest" — and the window must go in the REQUEST: narrowing after the fetch
 * drags the whole tenant back and only looks narrower.
 */
export const PO_LIST_PATH = "/services/rest/v1/purchase/purchaseOrder/getPurchaseOrders"

/** The web UI's print view, not a REST endpoint — see fetchPurchaseOrderPdf. */
export const PO_DOCUMENT_PATH = "/po/show"

export const EXPORT_JOB_CREATE_PATH = "/services/rest/v1/export/job/create"
export const EXPORT_JOB_STATUS_PATH = "/services/rest/v1/export/job/status"

export const VENDOR_ITEM_CREATE_OR_EDIT_PATH = "/services/rest/v1/purchase/vendorItemType/createOrEdit"

/** Absolute URL for a path Uniware handed back, which may be either absolute or
 *  tenant-relative. Used by the export download. */
export function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  return `${BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`
}
