// Uniware POs no ERP invoice owns (docs/uniware-manual-po-plan.md). Pure, so the UI and unit tests can import it.

export type ExternalPoItem = { sku_code: string; qty: number; unit_price: number | null; mrp: number | null }

/** missing = adoptable · replacement = its invoice is live in the ERP, revert that first · not_fg = no SKU-master lines. */
export type ExternalPoKind = "missing" | "replacement" | "not_fg" | "cancelled" | "adopted"

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
    })).filter((i) => i.sku_code),
  }
}

export function classifyExternalPo(row: {
  un_status: string | null
  all_fg: boolean
  adopted: boolean
  live_invoice_no: string | null
}): ExternalPoKind {
  if (row.adopted) return "adopted"
  if ((row.un_status ?? "").toUpperCase() === "CANCELLED") return "cancelled"
  if (!row.all_fg) return "not_fg"
  return row.live_invoice_no ? "replacement" : "missing"
}

/** Invoice SKUs the Uniware PO does not carry; adopting is refused while any remain. */
export function skusMissingFromPo(lineSkus: string[], items: ExternalPoItem[]): string[] {
  const onPo = new Set(items.map((i) => i.sku_code.toUpperCase()))
  return [...new Set(lineSkus.map((s) => s.trim()).filter((s) => s && !onPo.has(s.toUpperCase())))]
}
