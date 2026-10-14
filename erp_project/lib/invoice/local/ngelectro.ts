import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { findGstins, isOurs } from "@/lib/invoice/gstin"
import { clean, num, toLines, slashDateToTally } from "./util"

// The text layer comes out in print-position order, but each item's value line stays whole:
//   1 33059019 452582.400 452582.400 18.00 81464.830 0.0003984.000ENGN60021X250ML 534047.2300.00010/2026
//     └hsn────┘└material─┘└taxable──┘└gst%┘└gst amt┘└frt┘└qty───┘└batch─┘└pack─┘└gross────┘└frt%┘└mfg──┘
// then expiry, our SKU code (wrapped, or ahead of the rate), and "<cases>FG<interface code> <rate>".
const ROW = new RegExp(
  String.raw`^(?<sn>\d+) (?<hsn>\d{8}) (?<material>\d+\.\d{3}) (?<taxable>\d+\.\d{3}) (?<gst>\d+(?:\.\d+)?) \d+\.\d{3} ` +
  String.raw`(?<freight>\d+\.\d{3})(?<qty>\d+\.\d{3})(?<batch>\S+?)(?<pack>1X[\d.]+\s?(?:ML|GM|G|KG|L))\s+` +
  String.raw`\d+\.\d{3}\d+\.\d{3}(?<mfg>\d{2}\/\d{4})$`,
  "i"
)
const RATE = new RegExp(String.raw`^(?<pre>.*?\s)?\d+FG\d+ (?<rate>\d+\.\d{3})$`)
const EXPIRY = /^\d{2}\/\d{4}$/
const NUMBERED = /^\d+ \d{8} \d+\.\d{3} /

export function matchesNgElectro(text: string): boolean {
  return /Net Amount Payable/i.test(text) && /Total Basic Amount/i.test(text)
}

export function ngElectroRows(text: string): number {
  return toLines(text).filter((l) => NUMBERED.test(l)).length
}

// The description prints just above the row's "PO No" line, back to the previous row or the header.
function description(lines: string[], rowAt: number): string | null {
  const out: string[] = []
  for (let i = rowAt - (/^PO No\s*:/i.test(lines[rowAt - 1] ?? "") ? 2 : 1); i >= 0 && out.length < 3; i--) {
    const l = lines[i]
    if (RATE.test(l) || EXPIRY.test(l) || ROW.test(l) || /INS\. NO\.|Page No|\s:$|^[:\s]+$/i.test(l)) break
    out.unshift(l)
  }
  return clean(out.join(" ").replace(/\s+/g, " "))
}

function rows(lines: string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = []
  lines.forEach((line, i) => {
    const g = line.match(ROW)?.groups
    if (!g) return
    // Freight folded into the taxable value is not a goods amount; leave it to the metered parser.
    if (num(g.freight) !== 0 || g.material !== g.taxable) return

    const after = lines.slice(i + 1, i + 6)
    const rateAt = after.findIndex((l) => RATE.test(l))
    if (rateAt === -1 || !EXPIRY.test(after[0])) return
    const r = after[rateAt].match(RATE)!.groups!
    // Wrapped over lines and sometimes tagged, e.g. "HYPMUBX004" + "F030(NF)".
    const sku = [...after.slice(1, rateAt), r.pre ?? ""].join("").replace(/\s+/g, "").replace(/\(.*\)$/, "")

    items.push({
      sku_code: clean(sku),
      sku_name: description(lines, i),
      batch: clean(g.batch),
      mfg_date: clean(g.mfg),
      expiry: clean(after[0]),
      qty: num(g.qty),
      hsn: clean(g.hsn),
      rate: num(r.rate),
      mrp: null,
      discount: null,
      amount: num(g.material),
      gst_percent: num(g.gst),
      total_amount: null,
    })
  })
  return items
}

export function parseNgElectro(text: string): ParsedInvoice {
  const lines = toLines(text)
  const gstins = findGstins(text)

  // "Material Amt Freight Amt Taxabale Amt GST Amt Gross Value" with its figures on the next line.
  const summary = lines.findIndex((l) => /^Material Amt/i.test(l))
  const gross = summary === -1 ? null : num(lines[summary + 1]?.split(/\s+/).pop())
  const roundOff = num(text.match(/(-?\d+\.\d{2,3})\s*Round Off/i)?.[1]) ?? 0

  // The consignee follows "SALE ORDER NO.": its name, then address lines closed by "<city> - <PIN>".
  const shipAt = lines.findIndex((l) => /^SALE ORDER NO/i.test(l)) + 1
  const shipEnd = shipAt > 0 ? lines.findIndex((l, i) => i > shipAt && /-\s*\d{6}$/.test(l)) : -1
  const shipName = shipEnd === -1 ? null : lines[shipAt]
  const shipAddr = shipEnd === -1 ? null : lines.slice(shipAt + 1, shipEnd + 1).join(", ")
  // Glued to its label ("02AACCN5184H1ZMGST NO."), so findGstins' word boundary misses it.
  const seller = [...text.matchAll(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/g)].map((m) => m[0]).find((g) => !isOurs(g))

  return {
    invoice_number: clean(lines.find((l) => /^[A-Z0-9]+\/GIS\d+$/.test(l))),
    date: slashDateToTally(lines.find((l) => /^\d{2}\/\d{2}\/\d{4}$/.test(l))),
    eway_bill_number: clean(text.match(/E-WAY BILL NO\.?\s*(\d{12})/i)?.[1]),
    from: clean(lines.find((l) => /^N\.?\s?G\.? Electro/i.test(l))?.replace(/,\s*$/, "")),
    destination: clean(text.match(/^DESTINATION\s+(.+)$/im)?.[1]),
    vehicle_number: clean(text.match(/VEHICLE NO\.?\s+([A-Z0-9]+)\s*:/i)?.[1]),
    currency: "INR",
    seller_gstin: seller ?? null,
    buyer_gstin: gstins.find((g) => isOurs(g)) ?? null,
    bill_to_name: null,
    bill_to_address: null,
    bill_to_gstin: gstins.find((g) => isOurs(g)) ?? null,
    bill_to_state: null,
    ship_to_name: clean(shipName),
    ship_to_address: clean(shipAddr),
    ship_to_gstin: gstins.find((g) => isOurs(g)) ?? null,
    purchase_order: clean(text.match(/^PO No\s*:\s*(\S+)/m)?.[1]),
    // Net payable = gross value + round off, which is what the rest of the app books.
    total_amount: gross == null ? null : Math.round((gross + roundOff) * 100) / 100,
    line_items: rows(lines),
    extra: {},
  }
}
