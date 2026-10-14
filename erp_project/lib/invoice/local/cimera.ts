import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { findGstins, isOurs } from "@/lib/invoice/gstin"
import { clean, num, toLines, slashDateToTally } from "./util"

// Marg ERP, one line per item:
//   1. 33049930 M CAFFEINE SWEET. BODY LOTION 128 300ML 4608 - WB026 10/26 9/28 499.00 68.8100 0.00 18.00% 57073.8 317076.48
//      └hsn─────┘└name──────────────────────┘└cs┘└pack┘└qty┘└free└batch└mfg─└exp└mrp───┘└rate───┘└dis┘└igst%┘└igst──┘└amount─┘
const ROW = new RegExp(
  String.raw`^(?<sn>\d+)\.\s+(?<hsn>\d{8})\s+(?<name>.+?)\s+\d+\s+(?<pack>\d+\s?(?:ML|GM|G|KG|L))\s+` +
  String.raw`(?<qty>\d+(?:\.\d+)?)\s+(?:-|\d+)\s+(?<batch>\S+)\s+(?<mfg>\d{1,2}\/\d{2})\s+(?<exp>\d{1,2}\/\d{2})\s+` +
  String.raw`(?<mrp>[\d.]+)\s+(?<rate>[\d.]+)\s+(?<dis>[\d.]+)\s+(?<gst>[\d.]+)%\s+[\d.]+\s+(?<amount>[\d.]+)$`,
  "i"
)

export function matchesCimera(text: string): boolean {
  return /Marg ERP/i.test(text) && /C\.Order No/i.test(text)
}

export function cimeraRows(text: string): number {
  return toLines(text).filter((l) => /^\d+\.\s+\d{8}\s/.test(l)).length
}

export function cimeraDeclaredQty(text: string): number[] {
  const q = num(text.match(/Total Qty\s*:\s*-?\s*([\d,]+(?:\.\d+)?)/i)?.[1]?.replace(/,/g, ""))
  return q == null ? [] : [q]
}

function rows(lines: string[], sku: string | null): ParsedLineItem[] {
  return lines.flatMap((line) => {
    const g = line.match(ROW)?.groups
    if (!g) return []
    return [{
      sku_code: sku,
      sku_name: clean(`${g.name} ${g.pack}`),
      batch: clean(g.batch),
      mfg_date: clean(g.mfg),
      expiry: clean(g.exp),
      qty: num(g.qty),
      hsn: clean(g.hsn),
      rate: num(g.rate),
      mrp: num(g.mrp),
      discount: num(g.dis),
      amount: num(g.amount),
      gst_percent: num(g.gst),
      total_amount: null,
    }]
  })
}

export function parseCimera(text: string): ParsedInvoice {
  const lines = toLines(text)
  const gstins = findGstins(text)

  // Name, address lines, then "Phone No", under each party label.
  const party = (label: RegExp) => {
    const at = lines.findIndex((l) => label.test(l))
    if (at === -1) return { name: null, address: null, gstin: null }
    const end = lines.findIndex((l, i) => i > at && /^Phone No/i.test(l))
    const body = lines.slice(at + 1, end === -1 ? at + 1 : end)
    const gstin = lines.slice(at, at + 10).map((l) => l.match(/^GST No\s*:\s*([0-9A-Z]{15})/i)?.[1]).find(Boolean)
    return { name: clean(body[0]), address: clean(body.slice(1).join(", ")), gstin: clean(gstin) }
  }
  const billTo = party(/^Name and address of Buyer/i)
  const shipTo = party(/^Name and address of Consignee/i)

  // Our SKU code is printed only beside the customer order, e.g. "MPO-00113340(MCaf370)".
  const order = text.match(/C\.Order No\s*:\s*([A-Z0-9-]+)/i)?.[1]
  const codes = new Set([...text.matchAll(/C\.Order No[^\n]*?\(([A-Za-z0-9_]+)\)/gi)].map((m) => m[1]))
  const items = rows(lines, null)
  // Only stamped when one code and one product leave no doubt which line it belongs to.
  const names = new Set(items.map((i) => i.sku_name))
  if (codes.size === 1 && names.size === 1) for (const i of items) i.sku_code = [...codes][0]

  const copy = lines.findIndex((l) => /^Original for/i.test(l))
  const head = text.match(/Invoice No\s*:\s*(\S+)\s+Date\s*:\s*(\d{1,2})-(\d{1,2})-(\d{4})/i)

  return {
    invoice_number: clean(head?.[1]),
    date: head ? slashDateToTally(`${head[2]}/${head[3]}/${head[4]}`) : null,
    eway_bill_number: clean(text.match(/Eway bill No\s*:\s*(\d{12})/i)?.[1]),
    // The seller's name heads the page; the "For <seller>" sign-off is missing on some.
    from: clean((copy === -1 ? null : lines[copy + 1]) ?? text.match(/^For\s+(.+)$/m)?.[1]),
    destination: null,
    vehicle_number: clean(text.match(/Vehicle No\s*:\s*([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4})/i)?.[1]),
    currency: "INR",
    seller_gstin: gstins.find((g) => !isOurs(g)) ?? null,
    buyer_gstin: billTo.gstin ?? gstins.find((g) => isOurs(g)) ?? null,
    bill_to_name: billTo.name,
    bill_to_address: billTo.address,
    bill_to_gstin: billTo.gstin,
    bill_to_state: null,
    ship_to_name: shipTo.name,
    ship_to_address: shipTo.address,
    ship_to_gstin: shipTo.gstin,
    purchase_order: clean(order),
    // One decimal on some invoices, and the bank details run straight on: "1449832.0ACCOUNT NO."
    total_amount: num(text.match(/Grand total\s+(\d[\d,]*\.\d{1,2})/i)?.[1]),
    line_items: items,
    extra: {},
  }
}
