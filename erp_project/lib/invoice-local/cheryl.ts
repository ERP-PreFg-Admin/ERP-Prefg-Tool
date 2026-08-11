import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { findGstins, isOurs } from "@/lib/gstin"
import { MONEY, clean, num, toLines, slashDateToTally } from "./util"

// Item row, all columns run together, rate carrying four decimals:
//   52,481.52080.9900C26G202 648.00HYPHEN 10% VITAMIN C
//   └amount──┘└─rate──┘└batch┘ └qty─┘└ description...
const ROW = new RegExp(
  String.raw`^(?<amount>${MONEY})` +
  String.raw`(?<rate>\d+\.\d{4})` +
  String.raw`(?<batch>[A-Z0-9]+)\s+` +
  String.raw`(?<qty>${MONEY})` +
  String.raw`(?<name>.*)$`
)

// Sr. no, HSN and manufacturing date land on their own line below the row.
const TAIL = /^(\d+)\s+(\d{6,8})\s+(\S+)/
const SKU_LINE = /SKU\s*:?-?\s*([A-Z0-9]+)/i

export function matchesCheryl(text: string): boolean {
  return /NET INVOICE VALUE/i.test(text)
}

function rows(lines: string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = []
  const sku = lines.map((l) => l.match(SKU_LINE)?.[1]).find(Boolean) ?? null

  lines.forEach((line, i) => {
    const g = line.match(ROW)?.groups
    if (!g) return

    const after = lines.slice(i + 1, i + 8)
    const desc = [g.name, ...after.filter((l) => /^[A-Z0-9%\[\]\s.+-]+$/.test(l) && !TAIL.test(l) && l !== "Sale")]
    const tail = after.map((l) => l.match(TAIL)).find(Boolean)

    items.push({
      sku_code: sku,
      sku_name: clean(desc.join(" ").replace(/\s+/g, " ")),
      batch: clean(g.batch),
      mfg_date: clean(tail?.[3]),
      expiry: null,
      qty: num(g.qty),
      hsn: clean(tail?.[2]),
      rate: num(g.rate),
      mrp: null,
      discount: null,
      amount: num(g.amount),
      gst_percent: null,
      total_amount: null,
    })
  })

  return items
}

export function parseCheryl(text: string): ParsedInvoice {
  const lines = toLines(text)
  const gstins = findGstins(text)

  // Labels and values are emitted as separate blocks, so "the line under the
  // label" is meaningless here — the invoice number is matched by its shape.
  const invoiceNo = lines.find((l) => /^[A-Z]{2,}\/[\dA-Z-]+\/\d+$/.test(l)) ?? null

  const partyName = (label: RegExp) => {
    const at = lines.findIndex((l) => label.test(l))
    if (at <= 0) return null
    for (let i = at - 1; i >= 0; i--) {
      if (/^(GSTIN|State|D\.L\.|GstInvoice|:)/i.test(lines[i])) return clean(lines[i + 1])
    }
    return clean(lines[0])
  }

  const afterLabel = (label: RegExp, pattern: RegExp) => {
    const at = lines.findIndex((l) => label.test(l))
    if (at === -1) return null
    return clean(lines.slice(at, at + 5).map((l) => l.match(pattern)?.[1]).find(Boolean))
  }

  return {
    invoice_number: clean(invoiceNo),
    date: slashDateToTally(text),
    eway_bill_number: clean(text.match(/e-?way Bill No\.?\s*:?\s*(\d{10,})/i)?.[1]),
    from: clean(text.match(/^For,\s*(.+)$/mi)?.[1]),
    destination: null,
    vehicle_number: clean(text.match(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4})\b/)?.[1]),
    currency: "INR",
    seller_gstin: gstins.find((g) => !isOurs(g)) ?? null,
    buyer_gstin: gstins.find((g) => isOurs(g)) ?? null,
    bill_to_name: partyName(/^Buyer\s*\/\s*Billed To/i),
    bill_to_address: null,
    bill_to_gstin: afterLabel(/^Buyer\s*\/\s*Billed To/i, /GSTIN\s*:?\s*([0-9A-Z]{15})/i),
    bill_to_state: afterLabel(/^Buyer\s*\/\s*Billed To/i, /^State\s+([A-Za-z ]+),/i),
    ship_to_name: partyName(/^Consignee\s*\/\s*Shipped To/i),
    ship_to_address: null,
    purchase_order: null,
    total_amount: num(text.match(/NET INVOICE VALUE\s*:?\s*([\d,]+\.\d{2})/i)?.[1]),
    line_items: rows(lines),
    extra: {},
  }
}
