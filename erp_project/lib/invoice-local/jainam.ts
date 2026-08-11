import type { ParsedInvoice, ParsedLineItem } from "@/types/invoice"
import { findGstins, isOurs } from "@/lib/gstin"
import { MONEY, clean, num, toLines, slashDateToTally } from "./util"

// SAP Business One. Its item row ends with amount and unit price run together:
//   3304.99.90 76.00PcsUE260223 06/2028 499 381596.005021.00
//                                           └amount─┘└price┘
// Both always print two decimals, which is what lets them be told apart.
const ROW = new RegExp(
  String.raw`^(?<hsn>[\d.]+)\s+` +
  // uom is lazy and batch is anchored to letters-then-digits, or a greedy uom
  // eats the batch's own letter prefix: "PcsUE260223" -> uom "PcsUE", batch "260223".
  String.raw`(?<qty>${MONEY})(?<uom>[A-Za-z]+?)` +
  String.raw`(?<batch>[A-Z]{1,4}\d+)\s+` +
  String.raw`(?<expiry>\d{1,2}\/\d{4})\s+` +
  String.raw`(?<mrp>[\d,]+(?:\.\d+)?)\s+` +
  String.raw`(?<amount>${MONEY})(?<price>${MONEY})$`
)

const ITEM_START = /^(\d+)\s+(\S+)\s+(.*)$/
const SKU_LINE = /^SKU\s*[-:]\s*(\S+)/i

export function matchesJainam(text: string): boolean {
  return /Document Total/i.test(text) && /Basic Amount/i.test(text)
}

function rows(lines: string[]): ParsedLineItem[] {
  const start = lines.findIndex((l) => /^#\s*Description of/i.test(l))
  if (start === -1) return []

  const blocks: string[][] = []
  let current: string[] | null = null

  for (const line of lines.slice(start + 1)) {
    if (/^(Basic Amount|Total Tax|Document Total|HSN\/SAC)/i.test(line)) break

    if (ITEM_START.test(line) && !ROW.test(line)) {
      current = [line]
      blocks.push(current)
      continue
    }
    current?.push(line)
  }

  const items: ParsedLineItem[] = []
  for (const block of blocks) {
    const valueLine = block.find((l) => ROW.test(l))
    const g = valueLine?.match(ROW)?.groups
    if (!g) continue

    const [, , code, firstWords] = block[0].match(ITEM_START)!
    const descLines = [firstWords, ...block.slice(1, block.indexOf(valueLine!))]
    const sku = block.map((l) => l.match(SKU_LINE)?.[1]).find(Boolean) ?? null

    items.push({
      sku_code: sku ?? clean(code),
      sku_name: clean(descLines.join(" ").replace(/\s+/g, " ")),
      batch: clean(g.batch),
      mfg_date: null,
      expiry: clean(g.expiry),
      qty: num(g.qty),
      hsn: clean(g.hsn.replace(/\./g, "")),
      rate: num(g.price),
      mrp: num(g.mrp),
      discount: null,
      amount: num(g.amount),
      gst_percent: null,
      total_amount: null,
    })
  }
  return items
}

export function parseJainam(text: string): ParsedInvoice {
  const lines = toLines(text)
  const gstins = findGstins(text)

  const line_items = rows(lines)

  // Party names wrap across lines; the address always starts at the first line
  // carrying a digit, which is where the name stops.
  const nameFrom = (from: number) => {
    const parts: string[] = []
    for (let i = from; i < lines.length && parts.length < 4; i++) {
      if (/\d/.test(lines[i])) break
      parts.push(lines[i])
    }
    return clean(parts.join(" ").replace(/\s+/g, " "))
  }

  const gstinLines = lines
    .map((l, i) => (/^GSTIN\s*[:：]/i.test(l) ? i : -1))
    .filter((i) => i !== -1)

  // GSTINs appear in a fixed order: seller, then Bill To, then Ship To.
  const billGstin = clean(lines[gstinLines[1]]?.match(/([0-9A-Z]{15})/)?.[1])

  return {
    invoice_number: clean(lines.find((l) => /^Invoice No\s*:/i.test(l))?.split(":")[1]),
    date: slashDateToTally(lines.find((l) => /^Date\s*:/i.test(l))),
    eway_bill_number: clean(lines.find((l) => /^\d{12}$/.test(l))),
    from: clean(lines[0]),
    destination: null,
    vehicle_number: clean(text.match(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{3,4})\b/)?.[1]),
    currency: "INR",
    seller_gstin: gstins.find((g) => !isOurs(g)) ?? null,
    buyer_gstin: billGstin ?? gstins.find((g) => isOurs(g)) ?? null,
    bill_to_name: clean(lines.find((l) => /^Customer Name\s*:/i.test(l))?.split(":")[1]),
    // Addresses are interleaved with invoice metadata here with no delimiter that
    // holds up, so they are left out rather than guessed at.
    bill_to_address: null,
    bill_to_gstin: billGstin,
    bill_to_state: clean(lines.find((l) => /^StateCode\s*:/i.test(l))?.split(":")[1]?.replace(/\s*\(\d+\)\s*/, "")),
    ship_to_name: gstinLines[1] !== undefined ? nameFrom(gstinLines[1] + 1) : null,
    ship_to_address: null,
    purchase_order: null,
    total_amount: num(lines.find((l) => /^Document Total/i.test(l))?.match(new RegExp(MONEY))?.[0]),
    line_items,
    extra: {},
  }
}
