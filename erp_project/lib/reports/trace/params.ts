// URL → traceability query, shared by the page and the export so a file always matches its screen. Pure.

import type { TraceFilters } from "@/lib/queries/trace"
import type { BatchStatus } from "./batch-ledger"
import type { Provenance, ReceiptSource } from "./receipts"
import { TRACE_TABS, type TraceTab } from "./contracts"
import { batchKey } from "./normalise"

type SP = Record<string, string | string[] | undefined>
const str = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null)
const oneOf = <T extends string>(v: string | null, all: readonly T[]): T | null => (v && (all as readonly string[]).includes(v) ? (v as T) : null)

export const BATCH_STATUSES: readonly BatchStatus[] =
  ["matched", "short_received", "over_received", "billed_not_received", "received_not_billed", "grn_not_synced"]
export const PROVENANCES: readonly Provenance[] =
  ["all_invoiced", "partly_without_invoice", "no_invoice", "opening_balance", "nothing_received", "data_error"]
export const RECEIPT_SOURCES: readonly ReceiptSource[] = ["invoice", "invoice_revert", "backfill", "hand_fix", "manual", "unknown"]

export type TraceQuery = {
  tab: TraceTab
  filters: TraceFilters
  /** T2 only. */
  status: BatchStatus | null
  /** T6 only. */
  byMonth: boolean
  /** T3 only. */
  provenance?: Provenance | null
  /** T4 only. */
  source?: ReceiptSource | null
}

export function parseTraceQuery(sp: SP): TraceQuery {
  const tab = str(sp.tab)
  const batch = str(sp.batch)
  return {
    tab: tab && (TRACE_TABS as string[]).includes(tab) ? (tab as TraceTab) : "t1",
    filters: {
      mfgCode: str(sp.mfg),
      skuCode: str(sp.sku),
      poNo: str(sp.po),
      invoiceNo: str(sp.inv),
      invoiceExact: sp.exact === "1",
      // `bk` is an already-normalised key (row expand); `batch` is what a person typed.
      batchKey: str(sp.bk) ?? (batch ? batchKey(batch) : null),
      dateFrom: str(sp.from),
      dateTo: str(sp.to),
      destination: str(sp.dest),
    },
    status: oneOf(str(sp.status), BATCH_STATUSES),
    byMonth: sp.month === "1",
    provenance: oneOf(str(sp.prov), PROVENANCES),
    source: oneOf(str(sp.source), RECEIPT_SOURCES),
  }
}
