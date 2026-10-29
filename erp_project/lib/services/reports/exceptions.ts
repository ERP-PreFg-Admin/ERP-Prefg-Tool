// Exception inbox (views-plan B8): every open problem from the existing reports, one queue.
// Each type is read through its source report's own service, so a count here is that report's count.
// Turning source rows into inbox rows is pure: lib/reports/exceptions-build.ts.

import { getViewScope } from "@/lib/brand-view"
import { resolveAccess } from "@/lib/permissions"
import type { UserScope } from "@/lib/scope"
import { getT2 } from "@/lib/services/reports/trace/batches"
import { getT3 } from "@/lib/services/reports/trace/receipts"
import { getT5 } from "@/lib/services/reports/trace/lines"
import { getInvoiceExceptions, getRateVariance } from "@/lib/services/reports/invoice-checks"
import { getDataQuality } from "@/lib/services/reports/data-quality"
import { MATCH_TOLERANCE } from "@/lib/invoice/three-way"
import { reportToday } from "@/lib/reports/definitions"
import { EXCEPTION_META, type ExceptionType } from "@/lib/reports/exception-types"
import { buildExceptionRows, type ExceptionSources } from "@/lib/reports/exceptions-build"
import type { TraceFilters } from "@/lib/queries/trace"

/** Each source is read whole up to this many rows; above it the inbox says the type is incomplete. */
export const EXCEPTION_SOURCE_CAP = 5000

/** `scopeOverride` lets callers outside a request (scripts, the nightly snapshot) pass the scope explicitly. */
export async function getExceptions(
  userId: number, roles: string[], f: { mfgCode: string | null; type: ExceptionType | null }, scopeOverride?: UserScope,
) {
  const [inwarding, fg, scope] = await Promise.all([
    resolveAccess(userId, roles, "/po-tracking/po-inwarding").then((a) => a !== "none"),
    resolveAccess(userId, roles, "/po-tracking/po-procurement").then((a) => a !== "none"),
    scopeOverride ?? getViewScope(userId),
  ])
  const want = (t: ExceptionType) => (!f.type || f.type === t) &&
    (EXCEPTION_META[t].needs === "inwarding" ? inwarding : EXCEPTION_META[t].needs === "fg" ? fg : true)
  const tf: TraceFilters = { mfgCode: f.mfgCode, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null }
  const invFilters = { search: null, mfgCode: f.mfgCode, destination: null, dateFrom: null, dateTo: null }
  const cap = EXCEPTION_SOURCE_CAP
  const truncated: string[] = []
  const src: ExceptionSources = {}

  if ((["batch_not_received", "batch_short", "batch_not_billed", "short_dated"] as ExceptionType[]).some(want)) {
    const d = await getT2(scope, { ...tf, status: null }, cap + 1, 0)
    if (d.total > cap) truncated.push("Batch ledger")
    src.batches = d.rows
  }
  if (want("grn_unlinked")) {
    const d = await getT5(scope, tf, cap + 1, 0)
    if (d.total > cap) truncated.push("GRN lines")
    src.grnLines = d.rows
  }
  if (want("receipt_without_invoice")) {
    const d = await getT3(scope, tf, cap + 1, 0)
    if (d.total > cap) truncated.push("PO receipt ledger")
    src.pos = d.rows
  }
  if (want("rate_over_po")) {
    const d = await getRateVariance(userId, { ...invFilters, minAbsPct: MATCH_TOLERANCE * 100, limit: cap + 1, offset: 0 }, scope)
    if (d.total > cap) truncated.push("Rate vs PO")
    src.rates = d.rows
  }
  if (want("invoice_mismatch")) {
    const d = await getInvoiceExceptions(userId, { ...invFilters, badge: "exceptions", limit: cap, offset: 0 }, scope)
    if (d.capped) truncated.push("Invoice checks")
    src.invoices = d.rows
  }
  // Data quality has no manufacturer dimension, so it is left out when a manufacturer is chosen.
  if (want("data_quality") && !f.mfgCode) src.dq = (await getDataQuality(userId, roles, null, undefined, scope)).checks

  const today = reportToday()
  return { ...buildExceptionRows(src, want, today), truncated, today }
}
