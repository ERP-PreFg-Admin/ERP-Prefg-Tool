// T2 batch ledger: live invoice lines ⟗ that invoice's GRN lines on (invoice, SKU, batch key). Pure.
// Rules: docs/reporting/dataset-contracts.md T2.

import { MATCH_TOLERANCE } from "@/lib/invoice/three-way"
import { batchKey, batchMatch, skuKey, toYm } from "./normalise"
import { daysBetween, earliestYm, rejectionPct, shelfLife } from "./metrics"

export type LedgerInvoiceLine = {
  invoice_id: number
  sku_code: string | null
  sku_name: string | null
  batch: string | null
  expiry: string | null
  qty: number
  taxable: number
}

export type LedgerGrnLine = {
  invoice_id: number
  grn_code: string
  sku_code: string | null
  sku_name: string | null
  batch_code: string | null
  expiry: string | null
  quantity: number
  rejected_qty: number
  po_id: number | null
  /** IST `YYYY-MM-DD`; drives days_invoice_to_grn. */
  grn_created_on?: string | null
}

export type LedgerInvoice = {
  invoice_id: number
  invoice_no: string
  mfg_code: string
  mfg_name: string
  destination: string | null
  grn_synced_at: string | null
  /** Any grn_uniware row exists for this invoice. */
  has_grn: boolean
  /** IST `YYYY-MM-DD` the invoice was inwarded; drives shelf life and days to GRN. */
  inwarded_on?: string | null
}

export type BatchStatus =
  | "matched" | "short_received" | "over_received" | "billed_not_received" | "received_not_billed" | "grn_not_synced"

export type BatchLedgerRow = {
  invoice_id: number
  invoice_no: string
  mfg_code: string
  mfg_name: string
  destination: string | null
  sku_code: string
  sku_name: string | null
  batch_key: string
  invoice_batch: string
  grn_batch: string
  /** sku_level: no batch paired for this invoice + SKU (Uniware's own batch codes), so compared at SKU level. */
  batch_match: "exact" | "loose" | "sku_level" | null
  billed_qty: number
  billed_value: number
  grn_codes: string
  grn_gross_qty: number
  grn_rejected_qty: number
  grn_accepted_qty: number
  qty_gap: number
  invoice_expiry_ym: string
  grn_expiry_ym: string
  expiry_mismatch: boolean
  grn_unmatched_po: boolean
  status: BatchStatus
  grn_synced_at: string | null
  shelf_life_months_at_receipt: number | null
  short_dated: boolean
  days_invoice_to_grn: number | null
  rejection_pct: number | null
  /** Not a contract column: the inbox ages a batch from it. */
  inwarded_on: string | null
}

type Bucket = { inv: LedgerInvoiceLine[]; grn: LedgerGrnLine[] }

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x && x.trim() !== "").map((x) => x.trim()))]

export function batchStatus(hasGrn: boolean, billed: number, arrived: number, onInvoice: boolean, onGrn: boolean): BatchStatus {
  if (!hasGrn) return "grn_not_synced"
  if (!onInvoice) return "received_not_billed"
  if (!onGrn) return "billed_not_received"
  if (billed > 0 && arrived < billed * (1 - MATCH_TOLERANCE)) return "short_received"
  if (arrived > billed * (1 + MATCH_TOLERANCE)) return "over_received"
  return "matched"
}

/** batch_key of a row reconciled at SKU level (no invoice batch matched any GRN batch). */
export const SKU_LEVEL_KEY = "(sku level)"

export function buildBatchLedger(
  invoices: readonly LedgerInvoice[], lines: readonly LedgerInvoiceLine[], grnLines: readonly LedgerGrnLine[],
): BatchLedgerRow[] {
  const byInvoice = new Map(invoices.map((i) => [i.invoice_id, i]))
  // First (invoice, SKU), then batch within it: Uniware stores its own batch codes, so when no batch pairs at
  // all for an invoice + SKU the comparison falls back to SKU level (batch_match "sku_level").
  const skus = new Map<string, Bucket>()
  const sku = (invoiceId: number, code: string | null) => {
    const key = `${invoiceId}|${skuKey(code)}`
    let b = skus.get(key)
    if (!b) skus.set(key, (b = { inv: [], grn: [] }))
    return b
  }
  for (const l of lines) if (byInvoice.has(l.invoice_id)) sku(l.invoice_id, l.sku_code).inv.push(l)
  for (const g of grnLines) if (byInvoice.has(g.invoice_id)) sku(g.invoice_id, g.sku_code).grn.push(g)

  const buckets: (Bucket & { skuLevel: boolean })[] = []
  for (const { inv, grn } of skus.values()) {
    const invKeys = new Set(inv.map((l) => batchKey(l.batch)))
    const pairs = grn.some((g) => invKeys.has(batchKey(g.batch_code)))
    if (inv.length && grn.length && !pairs) { buckets.push({ inv, grn, skuLevel: true }); continue }
    const byKey = new Map<string, Bucket>()
    const at = (k: string) => { let b = byKey.get(k); if (!b) byKey.set(k, (b = { inv: [], grn: [] })); return b }
    for (const l of inv) at(batchKey(l.batch)).inv.push(l)
    for (const g of grn) at(batchKey(g.batch_code)).grn.push(g)
    for (const b of byKey.values()) buckets.push({ ...b, skuLevel: false })
  }

  const rows: BatchLedgerRow[] = []
  for (const { inv, grn, skuLevel } of buckets) {
    const head = byInvoice.get((inv[0] ?? grn[0]).invoice_id)!
    const billed = inv.reduce((s, l) => s + l.qty, 0)
    const gross = grn.reduce((s, g) => s + g.quantity, 0)
    const rejected = grn.reduce((s, g) => s + g.rejected_qty, 0)
    const invBatches = uniq(inv.map((l) => l.batch))
    const grnBatches = uniq(grn.map((g) => g.batch_code))
    const invYm = uniq(inv.map((l) => toYm(l.expiry)))
    const grnYm = uniq(grn.map((g) => toYm(g.expiry)))
    const life = shelfLife(earliestYm(invYm.join(" / ")) ?? earliestYm(grnYm.join(" / ")), head.inwarded_on)
    const firstGrn = uniq(grn.map((g) => g.grn_created_on ?? null)).sort()[0] ?? null
    rows.push({
      invoice_id: head.invoice_id,
      invoice_no: head.invoice_no,
      mfg_code: head.mfg_code,
      mfg_name: head.mfg_name,
      destination: head.destination,
      sku_code: (inv[0]?.sku_code ?? grn[0]?.sku_code ?? "").trim(),
      sku_name: inv[0]?.sku_name ?? grn[0]?.sku_name ?? null,
      batch_key: skuLevel ? SKU_LEVEL_KEY : batchKey(inv[0]?.batch ?? grn[0]?.batch_code),
      invoice_batch: invBatches.join(" / "),
      grn_batch: grnBatches.join(" / "),
      batch_match: skuLevel ? "sku_level" : inv.length && grn.length ? batchMatch(invBatches, grnBatches) ?? "exact" : null,
      billed_qty: billed,
      billed_value: inv.reduce((s, l) => s + l.taxable, 0),
      grn_codes: uniq(grn.map((g) => g.grn_code)).join(", "),
      grn_gross_qty: gross,
      grn_rejected_qty: rejected,
      grn_accepted_qty: gross - rejected,
      qty_gap: billed - gross,
      invoice_expiry_ym: invYm.join(" / "),
      grn_expiry_ym: grnYm.join(" / "),
      expiry_mismatch: invYm.length > 0 && grnYm.length > 0 && !invYm.some((y) => grnYm.includes(y)),
      grn_unmatched_po: grn.some((g) => g.po_id == null),
      status: batchStatus(head.has_grn, billed, gross, inv.length > 0, grn.length > 0),
      grn_synced_at: head.grn_synced_at,
      shelf_life_months_at_receipt: life.months,
      short_dated: life.shortDated,
      days_invoice_to_grn: daysBetween(head.inwarded_on, firstGrn),
      rejection_pct: rejectionPct(rejected, gross),
      inwarded_on: head.inwarded_on ?? null,
    })
  }
  return rows.sort((a, b) =>
    b.invoice_id - a.invoice_id || a.sku_code.localeCompare(b.sku_code) || a.batch_key.localeCompare(b.batch_key))
}
