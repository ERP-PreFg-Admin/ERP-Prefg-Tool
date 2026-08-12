// Form model for the Add Invoice review step — types, builders and the
// derived-value rules. Deliberately free of React so the mapping from a parsed
// invoice to a reviewable form, and the validation over it, can be read (and
// exercised) without rendering anything.

import { matchMfg, matchSku, matchWarehouse, toDateInputValue } from "@/lib/invoice-mapping"
import type { OpenPoOption, ParsedCharge, ParsedInvoice } from "@/types/invoice"
import type { MfgOption, SkuOption, WarehouseOption } from "../po-procurement/po-types"

/**
 * The invoice upload ceiling — the single source for the number AND the wording.
 *
 * It must stay in step with `client_max_body_size` in
 * /etc/nginx/conf.d/00-erp-limits.conf (written by deploy/user-data.sh). When
 * they disagreed — 10 MB here, nginx's 1 MB default there — the browser happily
 * uploaded a scanned invoice that nginx then refused with its own HTML error
 * page. Nothing in the app could read that page, so the dialog showed a bare
 * "Invoice parsing failed" and a proxy limit looked like a parser bug.
 */
export const MAX_BYTES = 10 * 1024 * 1024
export const MAX_MB = MAX_BYTES / 1024 / 1024

/**
 * The one place the "too large" wording lives, so the dropzone hint, the
 * picker's guard and the upload boundary can't drift apart. Returns null when
 * the file is fine.
 */
export function tooLargeMessage(file: File): string | null {
  if (file.size <= MAX_BYTES) return null
  // One decimal, so a 10.4 MB file isn't reported as "10 MB" against a 10 MB cap.
  const mb = (file.size / 1024 / 1024).toFixed(1)
  return `This invoice is ${mb} MB. Please upload a file up to ${MAX_MB} MB — scanned invoices ` +
    `usually shrink a lot if you scan in black and white or at a lower DPI.`
}

/** Everything is a string while the user is typing; coercion happens at submit. */
const s = (v: unknown) => (v == null ? "" : String(v))

/** One editable line-item row.
 *
 *  After a FIFO match a single printed invoice line becomes several of these —
 *  one per open PO it consumes — because the payload (and invoice_items_mfg)
 *  carry exactly one reference PO per line. `line_key` is what ties the splits
 *  back to the line they came from. */
export type Row = {
  /** Stable id of the printed invoice line this row belongs to. Several rows
   *  share one when a FIFO match split the line across POs; allocateFifo merges
   *  on it before re-allocating, so re-matching is idempotent. Not a React key —
   *  the table still keys by index. */
  line_key:     string
  sku_code:     string
  /** What the invoice actually printed — kept so the user can see what they're
   *  mapping from even after the SKU field is corrected. */
  parsed_code:  string
  sku_name:     string
  batch:        string
  /** As printed on the invoice — often month-only ("Jun-2026"), so kept as text
   *  rather than coerced to a date. */
  mfg_date:     string
  expiry:       string
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

/** Per-tab counter behind line_key. Only has to be unique within one review. */
let lineKeySeq = 0
const nextLineKey = () => `L${++lineKeySeq}`

export const emptyRow = (): Row => ({
  line_key: nextLineKey(),
  sku_code: "", parsed_code: "", sku_name: "", batch: "", mfg_date: "", expiry: "", hsn: "",
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
    line_key:     nextLineKey(),
    sku_code:     s(matchSku(li.sku_code, li.sku_name, skuOptions)?.sku_code),
    parsed_code:  s(li.sku_code),
    sku_name:     s(li.sku_name),
    batch:        s(li.batch),
    mfg_date:     s(li.mfg_date),
    expiry:       s(li.expiry),
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

/* ── FIFO allocation ──────────────────────────────────────────────────────── */

/** A SKU the open POs can't cover. */
export type Shortage = { sku_code: string; needed: number; available: number }

/** Quantities are DECIMAL(12,3); anything under this is float noise, not a gap. */
const QTY_EPSILON = 1e-6

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()
const roundTo = (n: number, dp: number) => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Oldest raise date first — the FIFO order. A PO with no date sorts last
 *  rather than first, so a missing value can never jump the queue. */
function byRaiseDate(a: OpenPoOption, b: OpenPoOption): number {
  const ad = String(a.date ?? ""), bd = String(b.date ?? "")
  if (ad !== bd) {
    if (!ad) return 1
    if (!bd) return -1
    return ad < bd ? -1 : 1
  }
  return a.id - b.id
}

const sumStr = (a: string, b: string, dp: number) =>
  a === "" && b === "" ? "" : String(roundTo((Number(a) || 0) + (Number(b) || 0), dp))

/**
 * Collapse a previous FIFO match back to one row per printed invoice line, so
 * re-matching starts from the invoice rather than from the last allocation.
 * Quantities and money add back up; every other field comes from the first
 * split, which is the one the user sees at the top of the group.
 */
function mergeSplits(rows: Row[]): Row[] {
  const byKey = new Map<string, Row>()
  const order: string[] = []
  rows.forEach((r, i) => {
    // A draft checkpointed before line_key existed has none — index keeps those
    // rows distinct instead of merging them all into one.
    const key = r.line_key || `_${i}`
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { ...r, line_key: key })
      order.push(key)
      return
    }
    byKey.set(key, {
      ...seen,
      qty:          sumStr(seen.qty, r.qty, 3),
      amount:       sumStr(seen.amount, r.amount, 2),
      total_amount: sumStr(seen.total_amount, r.total_amount, 2),
    })
  })
  return order.map((k) => byKey.get(k)!)
}

/**
 * Divide a money field across the chunks a line was split into, by qty share.
 * The last chunk takes the rounding remainder so the parts still sum to the
 * whole — otherwise the invoice total drifts by a paisa per split.
 */
function splitMoney(raw: string, chunks: number[], total: number): string[] {
  // Untouched when there's nothing to split — no reformatting of "100.00".
  if (chunks.length <= 1) return chunks.map(() => raw)
  const v = Number(raw)
  if (raw === "" || !Number.isFinite(v) || total <= 0) return chunks.map(() => raw)

  const out: string[] = []
  let used = 0
  chunks.forEach((q, i) => {
    const last = i === chunks.length - 1
    const part = last ? roundTo(v - used, 2) : roundTo((v * q) / total, 2)
    if (!last) used += part
    out.push(String(part))
  })
  return out
}

/**
 * Match every invoice line against the manufacturer's open POs, oldest raise
 * date first, and return the rows that allocation produces.
 *
 * A line consumes as many POs as its quantity needs, so one printed line can
 * become several rows — each an ordinary line item with its own reference PO,
 * which is what the payload and invoice_items_mfg already model. A PO's
 * remaining quantity is tracked across the *whole* invoice, so two lines for the
 * same SKU can't both claim it.
 *
 * A line the open POs can't cover keeps its shortfall as a row with no reference
 * PO. That row is then caught by collectProblems, which is why "not enough POs"
 * and "reference PO missing" are one mechanism rather than two.
 */
export function allocateFifo(
  rows: Row[],
  openPos: OpenPoOption[]
): { rows: Row[]; shortages: Shortage[] } {
  const buckets = new Map<string, OpenPoOption[]>()
  for (const po of openPos) {
    const key = norm(po.sku_code)
    if (!key) continue
    const list = buckets.get(key)
    if (list) list.push(po)
    else buckets.set(key, [po])
  }
  for (const list of buckets.values()) list.sort(byRaiseDate)

  const left = new Map<number, number>(
    openPos.map((p) => [p.id, Math.max(0, Number(p.remaining) || 0)])
  )

  const out: Row[] = []
  const shortages: Shortage[] = []

  for (const row of mergeSplits(rows)) {
    const sku = norm(row.sku_code)
    const qty = Number(row.qty)
    // Nothing to allocate against. Already reported by collectProblems as an
    // unmapped SKU or a bad quantity — don't say it twice as a shortage too.
    if (!sku || !(qty > 0)) {
      out.push({ ...row, reference_po_id: "" })
      continue
    }

    const picks: { poId: string; qty: number }[] = []
    let need = qty
    for (const po of buckets.get(sku) ?? []) {
      if (need <= QTY_EPSILON) break
      const avail = left.get(po.id) ?? 0
      if (avail <= QTY_EPSILON) continue
      const take = roundTo(Math.min(avail, need), 3)
      left.set(po.id, avail - take)
      picks.push({ poId: String(po.id), qty: take })
      need = roundTo(need - take, 3)
    }

    if (need > QTY_EPSILON) {
      shortages.push({
        sku_code: row.sku_code.trim(),
        needed: qty,
        available: roundTo(qty - need, 3),
      })
      picks.push({ poId: "", qty: need })
    }

    const chunkQtys = picks.map((p) => p.qty)
    const amounts = splitMoney(row.amount, chunkQtys, qty)
    const totals = splitMoney(row.total_amount, chunkQtys, qty)
    picks.forEach((p, i) => {
      out.push({
        ...row,
        qty: String(p.qty),
        reference_po_id: p.poId,
        amount: amounts[i],
        total_amount: totals[i],
      })
    })
  }

  return { rows: out, shortages }
}

/* ── Validation ───────────────────────────────────────────────────────────── */

/** Everything blocking submit, as sentences. Empty array = good to go. */
export function collectProblems(
  form: InvoiceForm,
  rows: Row[],
  poById: Map<string, OpenPoOption>,
  shortages: Shortage[] = []
): string[] {
  const out: string[] = []
  if (!form.invoiceNo.trim()) out.push("Invoice number is required.")
  if (!form.destination)      out.push("Select a destination.")
  if (rows.length === 0)      out.push("Add at least one line item.")

  // Name what the invoice printed rather than just "select a manufacturer" —
  // a fuzzy match that found nothing is a different problem from a blank field,
  // and the supplier's own wording is what the user has to reconcile against.
  if (!form.mfgId) {
    out.push(form.parsedFrom.trim()
      ? `"${form.parsedFrom.trim()}" doesn't match any manufacturer in the system.`
      : "Select a manufacturer.")
  }

  rows.forEach((r, i) => {
    if (r.sku_code.trim()) return
    out.push(r.parsed_code.trim()
      ? `Row ${i + 1}: "${r.parsed_code.trim()}" doesn't match any SKU in the system.`
      : `Row ${i + 1} has no mapped SKU.`)
  })

  const badQty = rows.filter((r) => !(Number(r.qty) > 0)).length
  if (badQty > 0) out.push(`${badQty} line item${badQty > 1 ? "s have" : " has"} an invalid quantity.`)

  // Totalled per SKU, not reported per row. allocateFifo raises one shortage per
  // row, and one invoice legitimately carries the same SKU on several lines — so
  // two lines of 2,640 with nothing to cover them produced the identical
  // sentence twice, which says no more than once and read as a rendering bug.
  // Summed, it also answers the question actually being asked: how much of this
  // SKU is uncovered altogether.
  const bySku = new Map<string, { sku_code: string; needed: number; available: number }>()
  for (const sh of shortages) {
    const key = norm(sh.sku_code)
    const agg = bySku.get(key)
    if (agg) {
      agg.needed = roundTo(agg.needed + sh.needed, 3)
      agg.available = roundTo(agg.available + sh.available, 3)
    } else {
      bySku.set(key, { sku_code: sh.sku_code, needed: sh.needed, available: sh.available })
    }
  }
  for (const sh of bySku.values()) {
    out.push(`Only ${sh.available} of ${sh.needed} ${sh.sku_code} are on open POs — ${roundTo(sh.needed - sh.available, 3)} short.`)
  }

  // Every line books against an existing order; there is no "raise an inward PO
  // for goods nobody ordered" path. Rows left blank by a shortage are already
  // named above, so only report the ones that aren't.
  const shortSkus = new Set(shortages.map((sh) => norm(sh.sku_code)))
  rows.forEach((r, i) => {
    if (r.reference_po_id || shortSkus.has(norm(r.sku_code))) return
    out.push(`Row ${i + 1} has no reference PO.`)
  })

  // Per PO, not per row: after a FIFO split two rows can legitimately share one
  // PO, and comparing each row on its own would pass while the pair overdraws it.
  // Checked here as well as server-side so the desk sees it before submitting.
  const claimed = new Map<string, number>()
  for (const r of rows) {
    if (!r.reference_po_id) continue
    claimed.set(r.reference_po_id, (claimed.get(r.reference_po_id) ?? 0) + (Number(r.qty) || 0))
  }
  for (const [poId, qty] of claimed) {
    const po = poById.get(poId)
    if (po && qty > Number(po.remaining) + QTY_EPSILON) {
      out.push(`Qty ${roundTo(qty, 3)} exceeds the ${Number(po.remaining)} outstanding on ${po.po_no}. Re-match to fix.`)
    }
  }
  return out
}

/**
 * Sum of the lines, compared against the printed invoice total to warn about drift.
 *
 * `total_amount` is already tax-inclusive, so it is used as printed. Everything else
 * on the row (`amount`, or rate x qty when the invoice printed only a rate) is
 * PRE-tax, and most of our suppliers apply GST once in the footer rather than per
 * row — so summing those raw understated the invoice by exactly the tax and showed a
 * permanent "18,819.12 under the invoice total" on every such document. Grossing the
 * pre-tax fallback up by the row's own rate fixes it; a row with no `gst_percent`
 * gets a multiplier of 1.0 and is unchanged from today.
 *
 * Display only. `toInwardPayload` deliberately does NOT do this — that value is
 * persisted to invoice_items_mfg, and a derived figure there is fabricated money.
 */
/**
 * The GST rate the goods rows carry, for grossing up a charge that doesn't
 * state its own. Takes the most common rate rather than the first, so one
 * mis-read row doesn't set the rate for the whole invoice.
 */
export function goodsGstPercent(rows: Row[]): number {
  const counts = new Map<number, number>()
  for (const r of rows) {
    const g = Number(r.gst_percent)
    if (Number.isFinite(g) && g > 0) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [rate, n] of counts) if (n > bestCount) { best = rate; bestCount = n }
  return best
}

/**
 * Charges grossed up the same way sumLineItems grosses the goods, so the two
 * can be added and compared against the invoice's own (post-tax) total.
 * Freight is taxed like anything else — Kain's ₹7,000 carries ₹1,260 of GST.
 */
export function sumCharges(charges: ParsedCharge[], fallbackGst: number): number {
  return charges.reduce((sum, c) => {
    const gst = c.gst_percent ?? fallbackGst
    return sum + c.amount * (1 + (Number(gst) || 0) / 100)
  }, 0)
}

/**
 * One row's value including GST.
 *
 * The Line Total column and sumLineItems both read this, so the figure shown
 * against a row and the figure compared to the invoice total cannot drift
 * apart — which they could when each computed its own.
 *
 * Prefers a tax-inclusive total when the invoice printed one; otherwise applies
 * the row's GST to its amount, falling back to qty x rate only when the amount
 * itself is missing.
 */
export function lineTotal(r: Row): number {
  const inclusive = Number(r.total_amount)
  if (inclusive) return inclusive

  const preTax = Number(r.amount) || (Number(r.rate) || 0) * (Number(r.qty) || 0)
  return preTax * (1 + (Number(r.gst_percent) || 0) / 100)
}

export function sumLineItems(rows: Row[]): number {
  return rows.reduce((sum, r) => sum + lineTotal(r), 0)
}

/**
 * Open POs offered for one line's picker.
 *
 * Filtered to the line's own SKU, not merely sorted by it: the picker only
 * appears now when that SKU has more than one live Recipe, and the question it asks
 * is "which version of *this product* did the goods come from". Offering another
 * SKU's POs would answer a question nobody asked.
 */
export function poOptionsFor(openPos: OpenPoOption[], skuCode: string): OpenPoOption[] {
  const target = skuCode.trim().toLowerCase()
  if (!target) return openPos
  return openPos.filter((p) => p.sku_code?.trim().toLowerCase() === target)
}

/** Live-Recipe facts per SKU, keyed lowercase, read off whichever open POs carry
 *  that SKU. Drives both the Recipe Code column and whether a line gets a picker. */
export function bomBySku(openPos: OpenPoOption[]): Map<string, { count: number; codes: string | null }> {
  const out = new Map<string, { count: number; codes: string | null }>()
  for (const p of openPos) {
    const key = norm(p.sku_code)
    if (key && !out.has(key)) out.set(key, { count: Number(p.live_bom_count) || 0, codes: p.bom_code })
  }
  return out
}

/** What matched, for the confirmation strip. Counted over printed invoice lines
 *  (line_key), not allocation rows — "4 of 4 SKUs matched" has to mean the four
 *  lines on the paper, however many POs they were split across. */
export function matchSummary(form: InvoiceForm, rows: Row[], shortages: Shortage[]) {
  const lines = new Map<string, Row>()
  rows.forEach((r, i) => { if (!lines.has(r.line_key || `_${i}`)) lines.set(r.line_key || `_${i}`, r) })
  const all = [...lines.values()]
  return {
    mfgMatched:  Boolean(form.mfgId),
    parsedFrom:  form.parsedFrom.trim(),
    skusMatched: all.filter((r) => r.sku_code.trim()).length,
    skuTotal:    all.length,
    allocated:   rows.filter((r) => r.reference_po_id).length,
    shortCount:  shortages.length,
  }
}

/** The reviewed form as the body /api/v1/purchase-orders/invoice expects.
 *  Header and per-line detail travel too — they're recorded verbatim on
 *  invoice_mfg / invoice_items_mfg, not just used to raise POs.
 *
 *  No attachment_key: the PDF is posted alongside this and stored server-side
 *  as step 1 of the commit, so the key doesn't exist yet at this point. */
export function toInwardPayload(form: InvoiceForm, rows: Row[]) {
  return {
    invoice_no:     form.invoiceNo.trim(),
    invoice_date:   form.invoiceDate || null,
    mfg_id:         Number(form.mfgId),
    destination:    form.destination,

    currency:        form.currency,
    eway_bill_no:    form.ewayBill,
    vehicle_no:      form.vehicleNo,
    po_ref:          form.poRef,
    seller_gstin:    form.sellerGstin,
    buyer_gstin:     form.buyerGstin,
    bill_to_name:    form.billToName,
    bill_to_address: form.billToAddress,
    bill_to_state:   form.billToState,
    ship_to_name:    form.shipToName,
    ship_to_address: form.shipToAddress,
    invoice_total:   form.invoiceTotal === "" ? null : Number(form.invoiceTotal),

    line_items: rows.map((r) => ({
      sku_code:     r.sku_code.trim(),
      qty:          Number(r.qty),
      unit_price:   r.rate === "" ? null : Number(r.rate),
      total_amount: r.total_amount !== "" ? Number(r.total_amount)
                  : r.amount       !== "" ? Number(r.amount)
                  : null,
      reference_po_id: r.reference_po_id ? Number(r.reference_po_id) : null,

      parsed_sku_code: r.parsed_code,
      sku_name:        r.sku_name,
      batch:           r.batch,
      mfg_date:        r.mfg_date,
      expiry:          r.expiry,
      hsn:             r.hsn,
      rate:            r.rate     === "" ? null : Number(r.rate),
      mrp:             r.mrp      === "" ? null : Number(r.mrp),
      discount:        r.discount === "" ? null : Number(r.discount),
      gst_percent:     r.gst_percent === "" ? null : Number(r.gst_percent),
      amount:          r.amount   === "" ? null : Number(r.amount),
    })),
  }
}
