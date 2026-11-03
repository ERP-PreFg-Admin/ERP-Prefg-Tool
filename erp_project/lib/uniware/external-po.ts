// Uniware POs no ERP invoice owns (docs/uniware-manual-po-plan.md). Pure, so the UI and unit tests can import it.

/** How far back the sweep and the Add Invoice picker look. */
export const EXTERNAL_PO_WINDOW_DAYS = 45

import { destinationTier } from "../invoice/po-eligibility"

/** received/rejected are Uniware's per-line receipt totals; absent on rows cached before they were kept. */
export type ExternalPoItem = {
  sku_code: string; qty: number; unit_price: number | null; mrp: number | null
  received_qty?: number | null; rejected_qty?: number | null
}

/** missing = adoptable · replacement = its invoice is live in the ERP, revert that first · not_fg = no SKU-master lines.
 *  duplicate = the live invoice's own Uniware PO has GRNs, so this one is the stray; cancel it in Uniware. */
export type ExternalPoKind = "missing" | "replacement" | "duplicate" | "not_fg" | "cancelled" | "adopted"

export type ExternalPoCandidate = {
  uniware_po_code: string
  facility_code: string
  mfg_id: number
  mfg_code: string | null
  reference_no: string | null
  un_status: string | null
  un_created_by: string | null
  un_created_at: string | null
  items: ExternalPoItem[]
  kind: ExternalPoKind
  /** The live ERP invoice holding the same number, for a replacement. */
  live_invoice_no: string | null
  live_invoice_uniware_po_code: string | null
  /** GRNs on that invoice's own Uniware PO, as last synced. */
  live_invoice_grn_count: number
}

/** create / relink / revert_request change the ERP; manual is for a person in Uniware; skip could not be done. */
export type FixAction = "create" | "relink" | "revert_request" | "manual" | "skip"

export type FixResult = {
  uniware_po_code: string
  facility_code: string
  mfg_code: string | null
  invoice_no: string | null
  action: FixAction
  /** True once written; always false on a preview. */
  done: boolean
  summary: string
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v == null || v === "" || !Number.isFinite(n) ? null : n
}

/** The invoice number in a ReferenceNo, which sometimes carries a note after it ("MBA2627/GIS00085 EXCESS PO"). */
export function invoiceNoFromReference(ref: string | null | undefined): string | null {
  const first = ref?.trim().split(/\s+/)[0]
  return first || null
}

/** Same invoice number, ignoring case and spacing. */
export function sameInvoiceNo(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase()
  return norm(a) !== "" && norm(a) === norm(b)
}

/** The fields the cache keeps from one getPurchaseOrderDetails response. */
export function mapPoDetail(header: Record<string, unknown>, items: Record<string, unknown>[]) {
  const custom = Array.isArray(header.customFieldValues)
    ? (header.customFieldValues as { fieldName?: string; fieldValue?: unknown }[])
    : []
  const ref = custom.find((c) => c.fieldName === "ReferenceNo")?.fieldValue
  const createdMs = Number(header.created)
  return {
    vendor_code: header.vendorCode == null ? null : String(header.vendorCode),
    reference_no: ref == null || String(ref).trim() === "" ? null : String(ref).trim().slice(0, 100),
    un_status: header.statusCode == null ? null : String(header.statusCode),
    grn_count: num(header.inflowReceiptsCount),
    un_created_by: header.createdBy == null ? null : String(header.createdBy).slice(0, 255),
    un_created_at: Number.isFinite(createdMs) && createdMs > 0 ? new Date(createdMs) : null,
    items: items.map((i): ExternalPoItem => ({
      sku_code: String(i.itemSKU ?? i.itemTypeSKU ?? "").trim(),
      qty: num(i.quantity) ?? 0,
      unit_price: num(i.unitPrice),
      mrp: num(i.maxRetailPrice),
      received_qty: num(i.receivedQuantity),
      rejected_qty: num(i.rejectedQuantity),
    })).filter((i) => i.sku_code),
  }
}

export function classifyExternalPo(row: {
  un_status: string | null
  all_fg: boolean
  adopted: boolean
  live_invoice_no: string | null
  live_invoice_grn_count?: number
}): ExternalPoKind {
  if (row.adopted) return "adopted"
  if ((row.un_status ?? "").toUpperCase() === "CANCELLED") return "cancelled"
  if (!row.all_fg) return "not_fg"
  if (!row.live_invoice_no) return "missing"
  return (row.live_invoice_grn_count ?? 0) > 0 ? "duplicate" : "replacement"
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** What the warehouse accepted on one line: received less rejected once anything is received, else the PO qty. */
export function acceptedQty(i: ExternalPoItem): number {
  const received = Number(i.received_qty ?? 0)
  if (received > 0) return round3(Math.max(0, received - Number(i.rejected_qty ?? 0)))
  return round3(i.qty)
}

export type OpenPo = { id: number; po_no: string; sku_code: string; destination: string | null; date: string | Date | null; remaining: number | string }
export type AllocatedLine = { sku_code: string; qty: number; unit_price: number | null; mrp: number | null; reference_po_id: number; po_no: string }
export type Shortfall = { sku_code: string; needed: number; available: number }

/** FIFO over the manufacturer's open POs, same warehouse first, never another warehouse's — as Add Invoice matches. */
export function allocateOpenPos(items: ExternalPoItem[], openPos: OpenPo[], destination: string) {
  const day = (d: OpenPo["date"]) => (d instanceof Date ? d.toISOString() : String(d ?? "")) || "9999"
  const left = new Map(openPos.map((p) => [p.id, Math.max(0, Number(p.remaining) || 0)]))
  const lines: AllocatedLine[] = []
  const shortfalls: Shortfall[] = []
  for (const item of items) {
    const need0 = acceptedQty(item)
    if (!(need0 > 0)) continue
    const pos = openPos
      .filter((p) => p.sku_code?.trim().toUpperCase() === item.sku_code.toUpperCase() && destinationTier(p.destination, destination) < 2)
      .sort((a, b) => destinationTier(a.destination, destination) - destinationTier(b.destination, destination)
        || day(a.date).localeCompare(day(b.date)) || a.id - b.id)
    let need = need0
    for (const p of pos) {
      if (need <= 1e-6) break
      const take = round3(Math.min(left.get(p.id) ?? 0, need))
      if (take <= 1e-6) continue
      left.set(p.id, round3((left.get(p.id) ?? 0) - take))
      lines.push({ sku_code: item.sku_code, qty: take, unit_price: item.unit_price, mrp: item.mrp, reference_po_id: p.id, po_no: p.po_no })
      need = round3(need - take)
    }
    if (need > 1e-6) shortfalls.push({ sku_code: item.sku_code, needed: need0, available: round3(need0 - need) })
  }
  return { lines, shortfalls }
}

/** Same SKUs at the same total qty each, so a relink changes no received quantity. */
export function sameSkuQty(a: { sku_code: string | null; qty: number | string }[], b: { sku_code: string; qty: number }[]): boolean {
  const tally = (rows: { sku_code: string | null; qty: number | string }[]) => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const k = (r.sku_code ?? "").trim().toUpperCase()
      if (k) m.set(k, round3((m.get(k) ?? 0) + Number(r.qty)))
    }
    return m
  }
  const ta = tally(a), tb = tally(b)
  return ta.size > 0 && ta.size === tb.size && [...ta].every(([k, q]) => Math.abs((tb.get(k) ?? NaN) - q) < 1e-6)
}

/** Invoice SKUs the Uniware PO does not carry; adopting is refused while any remain. */
export function skusMissingFromPo(lineSkus: string[], items: ExternalPoItem[]): string[] {
  const onPo = new Set(items.map((i) => i.sku_code.toUpperCase()))
  return [...new Set(lineSkus.map((s) => s.trim()).filter((s) => s && !onPo.has(s.toUpperCase())))]
}
