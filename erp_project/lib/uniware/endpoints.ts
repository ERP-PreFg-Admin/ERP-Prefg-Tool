import { UNIWARE_BASE_URL } from "@/lib/env"
export const BASE = UNIWARE_BASE_URL.replace(/\/+$/, "")

export const TIMEOUT_MS = 30_000

export const OAUTH_TOKEN_PATH = "/oauth/token"

export const PO_CREATE_PATH = "/services/rest/v1/purchase/purchaseOrder/create"
export const PO_DETAILS_PATH = "/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails"
export const GRN_LIST_PATH = "/services/rest/v1/purchase/inflowReceipt/getInflowReceipts"
export const GRN_DETAILS_PATH = "/services/rest/v1/purchase/inflowReceipt/getInflowReceipt"
export const PO_LIST_PATH = "/services/rest/v1/purchase/purchaseOrder/getPurchaseOrders"

export const PO_DOCUMENT_PATH = "/po/show"
export const SWITCH_FACILITY_PATH = "/data/user/switchfacility"

export const DOC_AUTH_PATH = "/data/document/auth/details/get"
export const DOCS_LIST_PATH = "/documents/list"
export const DOCS_DOWNLOAD_PATH = "/document/V2/download"
export const DOCS_UPLOAD_PATH = "/document/V2/upload"
export const DOCS_UPLOAD_ACK_PATH = "/document/V2/acknowledge/upload"

export const EXPORT_JOB_CREATE_PATH = "/services/rest/v1/export/job/create"
export const EXPORT_JOB_STATUS_PATH = "/services/rest/v1/export/job/status"

export const VENDOR_ITEM_CREATE_OR_EDIT_PATH = "/services/rest/v1/purchase/vendorItemType/createOrEdit"

export function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  return `${BASE}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`
}
