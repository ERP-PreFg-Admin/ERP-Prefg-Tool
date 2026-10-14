import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { findGstins, isOurs } from "@/lib/invoice/gstin"
import { clean, num, toLines, slashDateToTally } from "./util"

// Each item is a head line, the name wrapping on, then a tail line (sometimes glued to the name):
//   7360 539120.0033049910 Mcaffeine Damage Repair Lipid Repair Leave
//   In Cream 50ml
//   1 23050 Ml Oct-26 Sep-28 599.00 18.00 97041.6073.250Nos TSMC260240FGC-1748
// The tail's "23050" is shippers and pack run together; GST amount (2 dp) and rate (3 dp) likewise.
const HEAD = new RegExp(String.raw`^(?<qty>\d+(?:\.\d+)?) (?<amount>\d[\d,]*\.\d{2})(?<hsn>\d{8}) ?(?<name>.*)$`)
const TAIL = new RegExp(
  String.raw`(?<sn>\d+) \d+ ?(?:Ml|Gm|G|Kg|L|Ltr|Nos)\.? (?<mfg>[A-Z][a-z]{2}-\d{2}) (?<exp>[A-Z][a-z]{2}-\d{2}) ` +
  String.raw`(?<mrp>\d+(?:\.\d+)?) (?<gst>\d+(?:\.\d+)?) \d[\d,]*\.\d{2}(?<rate>\d+\.\d{3})[A-Za-z]+ (?<batch>\S+?)(?:FGC?-\d+)?$`,
  "i"
)

export function matchesSamrvir(text: string): boolean {
  return /AMOUNT IN VALUE/i.test(text) && /Total Qty\.\s*:/i.test(text)
}

// Heads and tails are counted apart, so an item missing either one fails the row-count check.
export function samrvirRows(text: string): number {
  const lines = toLines(text)
  return Math.max(lines.filter((l) => HEAD.test(l)).length, lines.filter((l) => TAIL.test(l)).length)
}

export function samrvirDeclaredQty(text: string): number[] {
  const q = num(text.match(/Total Qty\.\s*:\s*([\d,]+(?:\.\d+)?)/i)?.[1])
  return q == null ? [] : [q]
}

function rows(lines: string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEAD)?.groups
    if (!h) continue
    const name: string[] = []
    let t: RegExpMatchArray | null = null
    // The tail is on this line or one of the next few, after the name's wrapped part.
    for (let j = i, rest = h.name; j < Math.min(lines.length, i + 5); rest = lines[++j] ?? "") {
      if (j > i && HEAD.test(rest)) break
      t = rest.match(TAIL)
      name.push(t ? rest.slice(0, t.index) : rest)
      if (t) break
    }
    const g = t?.groups
    if (!g) continue
    items.push({
      sku_code: null,
      sku_name: clean(name.join(" ").replace(/\s+/g, " ")),
      batch: clean(g.batch),
      mfg_date: clean(g.mfg),
      expiry: clean(g.exp),
      qty: num(h.qty),
      hsn: clean(h.hsn),
      rate: num(g.rate),
      mrp: num(g.mrp),
      discount: null,
      amount: num(h.amount),
      gst_percent: num(g.gst),
      total_amount: null,
    })
  }
  return items
}

export function parseSamrvir(text: string): ParsedInvoice {
  const lines = toLines(text)
  const gstins = findGstins(text)

  // "Bill to : M/S PEP TECHNOLOGIES PRIVATE LIMITED-BILL TO…"; the address prints further down, unlabelled.
  const party = (label: RegExp) =>
    clean(lines.find((l) => label.test(l))?.replace(label, "").replace(/^M\/S\s+/i, "").replace(/…$/, ""))
  // Two "<PIN>Pin Code" lines, bill-to then ship-to on all but 2 of 27 invoices; a ship-to PIN
  // that is really our office falls through to address and GSTIN matching in review.
  const pins = lines.map((l) => l.match(/^(\d{6})Pin Code/i)?.[1]).filter(Boolean) as string[]
  const shipPin = pins[1] ?? pins[0]
  const destination = clean(lines.find((l) => /:Destination$/i.test(l))?.replace(/:Destination$/i, ""))
  const shipAddr = shipPin
    ? lines.find((l) => l.includes(shipPin) && !/Pin Code/i.test(l)) ?? `${destination ?? ""} - ${shipPin}`
    : null

  const seller = lines.find((l) => /BIOTECH|PVT\.?\s*LTD|PRIVATE LIMITED/i.test(l) && !/^(Bill|Ship) to/i.test(l))
  // Glued to its label (": 02ABCCS5315E1ZWGSTIN No"), so findGstins' word boundary misses it.
  const sellerGstin = [...text.matchAll(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/g)].map((m) => m[0]).find((g) => !isOurs(g))
  const invoiceNo = text.match(/\b([A-Z]{1,4}\/\d+\/\d{2}-\d{2})\b/)?.[1]

  return {
    invoice_number: clean(invoiceNo),
    date: slashDateToTally(text.match(/Invoice Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]),
    eway_bill_number: clean(text.match(/E-Way Bill No\.?\s*:?\s*(\d{12})/i)?.[1]),
    from: clean(seller),
    destination,
    vehicle_number: clean(lines.find((l) => /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(l))),
    currency: "INR",
    seller_gstin: sellerGstin ?? null,
    buyer_gstin: gstins.find((g) => isOurs(g)) ?? null,
    // The invoice number prints on the same line as the bill-to name.
    bill_to_name: clean(party(/^Bill to\s*:\s*/i)?.replace(invoiceNo ?? "\0", "")),
    bill_to_address: null,
    bill_to_gstin: gstins.find((g) => isOurs(g)) ?? null,
    bill_to_state: null,
    ship_to_name: party(/^Ship to\s*:\s*/i),
    ship_to_address: clean(shipAddr),
    ship_to_gstin: gstins.find((g) => isOurs(g)) ?? null,
    purchase_order: clean(text.match(/\b(MPO-[A-Z0-9-]+),\s*Date:/i)?.[1]),
    total_amount: num(text.match(/(\d[\d,]*\.\d{2})\s*Grand Total/i)?.[1]),
    line_items: rows(lines),
    extra: {},
  }
}
