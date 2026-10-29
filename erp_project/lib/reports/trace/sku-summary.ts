// T6 SKU summary: ordered masters → invoiced → received → GRN, per SKU × manufacturer (× month). Pure.
// GRN belongs to an invoice, not a PO month, so the month view leaves the GRN columns empty.

import { OPEN_STATUSES } from "@/lib/reports/definitions"
import { skuKey } from "./normalise"
import { rejectionPct } from "./metrics"

export type SkuMaster = {
  sku_code: string | null
  sku_name: string | null
  brand: string | null
  mfg_code: string
  mfg_name: string
  month: string
  qty: number
  received_qty: number
  status: string
  invoiced_qty: number
  invoice_ids: number[]
  batch_keys: string[]
}

export type SkuGrnLine = { invoice_id: number; sku_code: string | null; quantity: number; rejected_qty: number }

export type SkuSummaryRow = {
  sku_code: string
  sku_name: string | null
  brand: string | null
  mfg_code: string
  mfg_name: string
  month: string | null
  po_count: number
  ordered_qty: number
  received_qty: number
  invoiced_qty: number
  received_without_invoice: number
  grn_gross_qty: number | null
  grn_accepted_qty: number | null
  grn_rejected_qty: number | null
  open_qty: number
  closed_short_qty: number
  invoice_count: number
  batch_count: number
  fill_pct: number | null
  rejection_pct: number | null
}

const CLOSED = ["received", "short_closed"]

export function summarizeSkus(masters: readonly SkuMaster[], grn: readonly SkuGrnLine[], byMonth: boolean): SkuSummaryRow[] {
  const groups = new Map<string, SkuMaster[]>()
  for (const m of masters) {
    const key = [skuKey(m.sku_code), m.mfg_code, byMonth ? m.month : ""].join("|")
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  // GRN per (invoice, sku), so each invoice's receipt for a SKU is counted once per group.
  const grnBy = new Map<string, { gross: number; rejected: number }>()
  for (const g of grn) {
    const k = `${g.invoice_id}|${skuKey(g.sku_code)}`
    const cur = grnBy.get(k) ?? { gross: 0, rejected: 0 }
    grnBy.set(k, { gross: cur.gross + g.quantity, rejected: cur.rejected + g.rejected_qty })
  }

  const rows: SkuSummaryRow[] = []
  for (const ms of groups.values()) {
    const head = ms[0]
    const sku = skuKey(head.sku_code)
    const invoices = new Set(ms.flatMap((m) => m.invoice_ids))
    const ordered = ms.reduce((s, m) => s + m.qty, 0)
    const received = ms.reduce((s, m) => s + m.received_qty, 0)
    const invoiced = ms.reduce((s, m) => s + m.invoiced_qty, 0)
    let gross = 0, rejected = 0
    for (const id of invoices) {
      const g = grnBy.get(`${id}|${sku}`)
      if (g) { gross += g.gross; rejected += g.rejected }
    }
    const gap = (m: SkuMaster) => Math.max(m.qty - m.received_qty, 0)
    rows.push({
      sku_code: (head.sku_code ?? "").trim(),
      sku_name: head.sku_name,
      brand: head.brand,
      mfg_code: head.mfg_code,
      mfg_name: head.mfg_name,
      month: byMonth ? head.month : null,
      po_count: ms.length,
      ordered_qty: ordered,
      received_qty: received,
      invoiced_qty: invoiced,
      received_without_invoice: received - invoiced,
      grn_gross_qty: byMonth ? null : gross,
      grn_accepted_qty: byMonth ? null : gross - rejected,
      grn_rejected_qty: byMonth ? null : rejected,
      open_qty: ms.filter((m) => (OPEN_STATUSES as readonly string[]).includes(m.status)).reduce((s, m) => s + gap(m), 0),
      closed_short_qty: ms.filter((m) => CLOSED.includes(m.status)).reduce((s, m) => s + gap(m), 0),
      invoice_count: invoices.size,
      batch_count: new Set(ms.flatMap((m) => m.batch_keys)).size,
      fill_pct: ordered > 0 ? (received / ordered) * 100 : null,
      rejection_pct: byMonth ? null : rejectionPct(rejected, gross),
    })
  }
  return rows.sort((a, b) =>
    a.sku_code.localeCompare(b.sku_code) || a.mfg_code.localeCompare(b.mfg_code) || (b.month ?? "").localeCompare(a.month ?? ""))
}
