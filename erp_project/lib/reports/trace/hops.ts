// Row expand (views-plan A1): each dataset row's next hop, as dataset + URL params for the rows route. Pure.

import type { TraceTab } from "./contracts"

export type Hop = { tab: TraceTab; label: string; params: Record<string, string> }

const s = (v: unknown) => (v == null ? "" : String(v))
/** Pin an invoice exactly (inv + exact) and a batch by its already-normalised key (bk). */
// A SKU-level batch row ("(sku level)") pins invoice + SKU only: its batches never paired, so no batch filter.
const lineKey = (r: Record<string, unknown>) => ({
  inv: s(r.invoice_no), exact: "1", sku: s(r.sku_code), ...(r.batch_match === "sku_level" ? {} : { bk: s(r.batch_key) }),
})

export function nextHops(tab: TraceTab, r: Record<string, unknown>): Hop[] {
  switch (tab) {
    case "t1": return [{ tab: "t5", label: "GRN lines for this batch", params: lineKey(r) }]
    case "t2": return [
      { tab: "t1", label: "Invoice lines", params: lineKey(r) },
      { tab: "t5", label: "GRN lines", params: lineKey(r) },
    ]
    case "t3": return [{ tab: "t1", label: "Invoice lines against this PO", params: { po: s(r.po_no) } }]
    case "t4": return r.invoice_no
      ? [{ tab: "t1", label: "Matched invoice lines", params: { po: s(r.po_no), inv: s(r.invoice_no), exact: "1" } }]
      : []
    case "t5": return [{ tab: "t1", label: "Invoice lines for this batch", params: lineKey(r) }]
    case "t6": return [{ tab: "t3", label: "POs for this SKU", params: { sku: s(r.sku_code), mfg: s(r.mfg_code) } }]
  }
}
