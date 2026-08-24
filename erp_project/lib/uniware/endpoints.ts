import { UNIWARE_BASE_URL } from "@/lib/env"

/** Trailing slashes stripped so `${BASE}${PATH}` never doubles them. */
export const BASE = UNIWARE_BASE_URL.replace(/\/+$/, "")

/** Transport timeout for every call except the export download, which is a few
 *  MB and sets its own. */
export const TIMEOUT_MS = 30_000

export const OAUTH_TOKEN_PATH = "/oauth/token"

export const PO_CREATE_PATH = "/services/rest/v1/purchase/purchaseOrder/create"
export const PO_DETAILS_PATH = "/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails"

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
