export { uniwareEnabled, getToken } from "./auth"
export type { UniwareToken } from "./auth"

export { uniwareFacility, uniwareVendorCode } from "./facility"

export { futureDeliveryDate, mergeItemsBySku, buildPurchaseOrder } from "./po-builder"
export type { UniwarePoItem, UniwarePoInput } from "./po-builder"

export { createPurchaseOrder, fetchPurchaseOrderPdf, fetchPurchaseOrderStatus, pushPurchaseOrders } from "./purchase-order"
export type { UniwarePushResult } from "./purchase-order"

export {
  EXPORT_COLUMNS_KEY, VENDOR_ITEM_EXPORT, VENDOR_ITEM_COLUMNS, SALE_ORDER_EXPORT,
  isFatalExportError, UniwareFatalError,
  createExportJob, getExportJobStatus, classifyJobStatus, pollExportJob, downloadExportCsv,
} from "./export-jobs"
export type { ExportJobStatus, ExportFilter } from "./export-jobs"

export { createVendorItem } from "./vendor-items"
export type { UniwareVendorItemInput } from "./vendor-items"

export { fetchInflowReceiptCodes, fetchInflowReceipt, fetchGrnsForPo } from "./grn"
export type { Grn, GrnItem } from "./grn-map"
export { grnTotalsByPo, reconcile, rejectedAmount } from "./grn-totals"
export type { PoGrnTotals, Reconciliation, GrnTotalRow } from "./grn-totals"

// ./errors is deliberately NOT re-exported here.
//
// It is the one file in this folder that client components use, and it imports
// nothing so that it cannot pull @/lib/env — and with it UNIWARE_PASSWORD — into
// a client bundle. Re-exporting it would defeat that: a "use client" file
// reaching for uniwareErrorMessage from "@/lib/uniware" would load this barrel,
// hence ./auth, hence @/lib/env.
//
// UI imports "@/lib/uniware/errors" directly. See the header of ./errors.ts.

export { mintCapability, isWebCookieValid, listDocuments, downloadDocument, uploadDocument, DOC_MAX_BYTES } from "./document"
export type { DocCapability, UniwareDocument } from "./document"
export { getUniwareWebCookie, requireUniwareWebCookie, getUniwareWebSessionInfo, UniwareSessionStale } from "./web-session"