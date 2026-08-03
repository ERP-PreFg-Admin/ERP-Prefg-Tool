// Form model for the Add Invoice review step — types, builders and the
// derived-value rules. Deliberately free of React so the mapping from a parsed
// invoice to a reviewable form, and the validation over it, can be read (and
// exercised) without rendering anything.

import { matchMfg, matchSku, matchWarehouse, toDateInputValue } from "@/lib/invoice-mapping"
import type { OpenPoOption, ParsedInvoice } from "@/types/invoice"
import type { MfgOption, SkuOption, WarehouseOption } from "../po-procurement/po-types"

/** Matches /api/upload's own cap and the parse route's. */
export const MAX_BYTES = 10 * 1024 * 1024

/** Everything is a string while the user is typing; coercion happens at submit. */
const s = (v: unknown) => (v == null ? "" : String(v))

/** One editable line-item row. */
export type Row = {
  sku_code:     string
  /** What the invoice actually printed — kept so the user can see what they're
   *  mapping from even after the SKU field is corrected. */
  parsed_code:  string
  sku_name:     string
  batch:        string
  hsn:          string
  qty:          string
  rate:         string
  mrp:          string
  discount:     string
  gst_percent:  string
  amount:       string
  total_amount: string
  /** Existing open PO this line is received against, as a string id ("" = none).
   *  When set, the line books a receipt instead of creating a new inward PO. */
  reference_po_id: string
}

/** The header/party half of the review form. One object rather than twenty
 *  useState calls — reset and prefill are then single assignments. */
export type InvoiceForm = {
  invoiceNo:     string
  invoiceDate:   string
  currency:      string
  ewayBill:      string
  vehicleNo:     string
  poRef:         string
  mfgId:         string
  destination:   string
  sellerGstin:   string
  buyerGstin:    string
  invoiceTotal:  string
  /** Raw parsed strings, shown beside the pickers so the user can sanity-check
   *  the fuzzy match instead of trusting it blind. */
  parsedFrom:    string
  parsedDest:    string
  billToName:    string
  billToAddress: string
  billToState:   string
  shipToName:    string
  shipToAddress: string
}

export const EMPTY_FORM: InvoiceForm = {
  invoiceNo: "", invoiceDate: "", currency: "", ewayBill: "", vehicleNo: "",
  poRef: "", mfgId: "", destination: "", sellerGstin: "", buyerGstin: "",
  invoiceTotal: "", parsedFrom: "", parsedDest: "",
  billToName: "", billToAddress: "", billToState: "", shipToName: "", shipToAddress: "",
}

export const emptyRow = (): Row => ({
  sku_code: "", parsed_code: "", sku_name: "", batch: "", hsn: "",
  qty: "", rate: "", mrp: "", discount: "", gst_percent: "", amount: "", total_amount: "",
  reference_po_id: "",
})

/** Build the header form from a parse result. Every value is a suggestion — the
 *  whole point of the review step is that the user can override it. */
export function formFromParsed(
  p: ParsedInvoice,
  mfgOptions: MfgOption[],
  warehouseOptions: WarehouseOption[]
): InvoiceForm {
  return {
    invoiceNo:     s(p.invoice_number),
    invoiceDate:   toDateInputValue(p.date),
    currency:      s(p.currency) || "INR",
    ewayBill:      s(p.eway_bill_number),
    vehicleNo:     s(p.vehicle_number),
    poRef:         s(p.purchase_order),
    mfgId:         s(matchMfg(p.from, mfgOptions)?.id),
    destination:   s(matchWarehouse(p.destination, warehouseOptions)?.name),
    sellerGstin:   s(p.seller_gstin),
    // The bill-to block's GSTIN is the same number on most invoices, so it's a
    // reasonable fallback when the top-level field didn't come through.
    buyerGstin:    s(p.buyer_gstin) || s(p.bill_to_gstin),
    invoiceTotal:  s(p.total_amount),
    parsedFrom:    s(p.from),
    parsedDest:    s(p.destination),
    billToName:    s(p.bill_to_name),
    billToAddress: s(p.bill_to_address),
    billToState:   s(p.bill_to_state),
    shipToName:    s(p.ship_to_name),
    shipToAddress: s(p.ship_to_address),
  }
}

export function rowsFromParsed(p: ParsedInvoice, skuOptions: SkuOption[]): Row[] {
  return (p.line_items ?? []).map((li) => ({
    sku_code:     s(matchSku(li.sku_code, li.sku_name, skuOptions)?.sku_code),
    parsed_code:  s(li.sku_code),
    sku_name:     s(li.sku_name),
    batch:        s(li.batch),
    hsn:          s(li.hsn),
    qty:          s(li.qty),
    rate:         s(li.rate),
    mrp:          s(li.mrp),
    discount:     s(li.discount),
    gst_percent:  s(li.gst_percent),
    amount:       s(li.amount),
    total_amount: s(li.total_amount),
    reference_po_id: "",
  }))
}

/** Everything blocking submit, as sentences. Empty array = good to go. */
export function collectProblems(
  form: InvoiceForm,
  rows: Row[],
  poById: Map<string, OpenPoOption>
): string[] {
  const out: string[] = []
  if (!form.invoiceNo.trim()) out.push("Invoice number is required.")
  if (!form.mfgId)            out.push("Select a manufacturer.")
  if (!form.destination)      out.push("Select a destination.")
  if (rows.length === 0)      out.push("Add at least one line item.")

  // A referenced line becomes a receipt against an existing PO, which is keyed
  // by PO id — it never needs a mapped SKU.
  const unmapped = rows.filter((r) => !r.reference_po_id && !r.sku_code.trim()).length
  if (unmapped > 0) out.push(`${unmapped} line item${unmapped > 1 ? "s have" : " has"} no mapped SKU.`)

  const badQty = rows.filter((r) => !(Number(r.qty) > 0)).length
  if (badQty > 0) out.push(`${badQty} line item${badQty > 1 ? "s have" : " has"} an invalid quantity.`)

  // Checked here as well as server-side so the desk sees it before submitting.
  for (const r of rows) {
    const po = poById.get(r.reference_po_id)
    if (po && Number(r.qty) > Number(po.remaining)) {
      out.push(`Qty ${r.qty} exceeds the ${Number(po.remaining)} outstanding on ${po.po_no}.`)
    }
  }
  return out
}

/** Line total, falling back to rate x qty when the invoice printed only a rate. */
export function sumLineItems(rows: Row[]): number {
  return rows.reduce((sum, r) => {
    const explicit = Number(r.total_amount) || Number(r.amount)
    return sum + (explicit || (Number(r.rate) || 0) * (Number(r.qty) || 0))
  }, 0)
}

/**
 * Open POs for one line's picker, with the ones matching that line's SKU floated
 * to the top. Not filtered to them — the invoice SKU and the ordered SKU
 * legitimately differ (substitutions, renamed codes), and fuzzy search still
 * reaches the rest of the list.
 */
export function poOptionsFor(openPos: OpenPoOption[], skuCode: string): OpenPoOption[] {
  if (!skuCode) return openPos
  const target = skuCode.trim().toLowerCase()
  return [...openPos].sort((a, b) => {
    const am = a.sku_code?.trim().toLowerCase() === target ? 0 : 1
    const bm = b.sku_code?.trim().toLowerCase() === target ? 0 : 1
    return am - bm
  })
}

/** The reviewed form as the body /api/purchase-orders/invoice expects. */
export function toInwardPayload(form: InvoiceForm, rows: Row[], attachmentKey: string) {
  return {
    attachment_key: attachmentKey,
    invoice_no:     form.invoiceNo.trim(),
    invoice_date:   form.invoiceDate || null,
    mfg_id:         Number(form.mfgId),
    destination:    form.destination,
    line_items: rows.map((r) => ({
      sku_code:     r.sku_code.trim(),
      qty:          Number(r.qty),
      unit_price:   r.rate === "" ? null : Number(r.rate),
      total_amount: r.total_amount !== "" ? Number(r.total_amount)
                  : r.amount       !== "" ? Number(r.amount)
                  : null,
      reference_po_id: r.reference_po_id ? Number(r.reference_po_id) : null,
    })),
  }
}
