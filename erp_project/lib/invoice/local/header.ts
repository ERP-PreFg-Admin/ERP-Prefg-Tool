import { findGstins, isOurs } from "@/lib/invoice/gstin"

// The rupee sign extracts as "₹" from some Tally PDFs and as "ī" from others,
// depending on how the font is embedded. Both mean the same column.
const RUPEE = "[₹ī]"

const MONEY = /\d[\d,]*\.\d{2}/
const DATE = /\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b/
const VEHICLE = /\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4})\b/

const LABEL = new RegExp(
  [
    "^Delivery Note", "^Reference No", "^Buyer[’']s Order No", "^Buyer's Order No",
    "^Dispatch Doc No", "^Dispatched through", "^Bill of Lading", "^Dated$",
    "^Mode/Terms of Payment", "^Other References", "^Destination$", "^Terms of Delivery",
    "^Motor Vehicle No", "^Place of Supply", "^Delivery Note Date", "^Invoice No",
    "^e-Way Bill No", "^GSTIN/UIN", "^State Name", "^Sl\\b", "^Description of",
  ].join("|"),
  "i"
)

function clean(s: string | null | undefined): string | null {
  const out = (s ?? "").trim()
  return out.length ? out : null
}

function num(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

function after(lines: string[], label: RegExp): string | null {
  const i = lines.findIndex((l) => label.test(l))
  if (i === -1) return null
  const next = lines[i + 1]
  if (!next || LABEL.test(next)) return null
  return clean(next)
}

const GSTIN_LINE = /^GSTIN\/UIN\s*[:：]?\s*([0-9A-Z]{15})\b/i
const STATE_LINE = /^State Name\s*:\s*([^,]+)/i

function block(lines: string[], label: RegExp) {
  const start = lines.findIndex((l) => label.test(l))
  if (start === -1) return { name: null, address: null, gstin: null, state: null }

  const stop = lines.findIndex(
    (l, i) => i > start + 1 && (/^(Consignee|Buyer)\s*\(/i.test(l) || /^Invoice No/i.test(l))
  )
  const body = lines.slice(start + 1, stop === -1 ? lines.length : stop)

  const gstinAt = body.findIndex((l) => GSTIN_LINE.test(l))
  const address = gstinAt > 0 ? body.slice(1, gstinAt).filter((l) => l !== "-") : []

  // "State Name" does not always sit directly under the GSTIN — some invoices
  // print "PAN/IT No :" between them — so look a few lines past it.
  const state = gstinAt === -1
    ? null
    : body.slice(gstinAt + 1, gstinAt + 4).map((l) => l.match(STATE_LINE)?.[1]).find(Boolean)

  return {
    name: clean(body[0]),
    address: address.length ? address.join(", ") : null,
    gstin: gstinAt === -1 ? null : body[gstinAt].match(GSTIN_LINE)![1],
    state: clean(state),
  }
}

function sellerName(lines: string[]): string | null {
  const marker = lines.findIndex((l) => /^e-?invoice$/i.test(l))
  const raw = marker >= 0
    ? lines[marker + 1]
    : lines.find((l) => l && !/^(tax invoice|irn|ack no|ack date)/i.test(l))

  return clean(raw?.replace(/\s*-?\s*\([^)]*\)\s*$/, ""))
}

function grandTotal(lines: string[]): number | null {
  const withGlyph = lines.find((l) => /^Total\b/i.test(l) && new RegExp(RUPEE).test(l))
  const anyTotal = lines.find((l) => /^Total\b/i.test(l) && MONEY.test(l))
  return num((withGlyph ?? anyTotal)?.match(MONEY)?.[0])
}

export type ParsedHeader = {
  invoice_number: string | null
  eway_bill_number: string | null
  date: string | null
  from: string | null
  destination: string | null
  vehicle_number: string | null
  currency: string
  seller_gstin: string | null
  buyer_gstin: string | null
  bill_to_name: string | null
  bill_to_address: string | null
  bill_to_gstin: string | null
  bill_to_state: string | null
  ship_to_name: string | null
  ship_to_address: string | null
  purchase_order: string | null
  total_amount: number | null
}

export function parseHeader(text: string): ParsedHeader {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  const invoiceLine = after(lines, /^Invoice No\.?/i) ?? ""
  const [invoiceNo, second] = invoiceLine.split(/\s+/)

  const gstins = findGstins(text)
  const seller = gstins.find((g) => !isOurs(g)) ?? null

  const dateIndex = lines.findIndex((l) => /^Dated$/i.test(l))
  const date = dateIndex >= 0 ? clean(lines[dateIndex + 1]?.match(DATE)?.[1]) : null

  const billTo = block(lines, /^Buyer\s*\(Bill to\)/i)
  const shipTo = block(lines, /^Consignee\s*\(Ship to\)/i)

  // The invoiced party comes from the Bill-to block, not from document order —
  // Ship-to is printed first, so "first GSTIN that is ours" picks the wrong one
  // whenever the goods ship somewhere other than the billing address.
  const buyer = billTo.gstin ?? gstins.find((g) => isOurs(g)) ?? null

  return {
    invoice_number: clean(invoiceNo),
    eway_bill_number: /^\d{10,}$/.test(second ?? "") ? second : null,
    date: date ?? clean(text.match(DATE)?.[1]),
    from: sellerName(lines),
    destination: after(lines, /^Destination$/i),
    vehicle_number: clean(text.match(VEHICLE)?.[1]),
    currency: "INR",
    seller_gstin: seller,
    buyer_gstin: buyer,
    bill_to_name: billTo.name,
    bill_to_address: billTo.address,
    bill_to_gstin: billTo.gstin,
    bill_to_state: billTo.state,
    ship_to_name: shipTo.name,
    ship_to_address: shipTo.address,
    purchase_order: after(lines, /^Buyer[’']s Order No\.?/i),
    total_amount: grandTotal(lines),
  }
}
