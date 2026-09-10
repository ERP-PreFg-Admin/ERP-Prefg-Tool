import type { ParsedLineItem } from "@/types/invoice"

const MONEY = String.raw`\d[\d,]*\.\d{2}`
const QTY = String.raw`\d[\d,]*(?:\.\d+)?`
const UNIT = String.raw`[A-Za-z.'’]+`

const ROW = new RegExp(
  String.raw`(?<amount>${MONEY})` +
  String.raw`(?:${UNIT})` +
  String.raw`(?<rate>${MONEY})` +
  String.raw`(?<qty>${QTY})\s*(?:${UNIT})` +
  String.raw`(?<rest>.*)$`
)

const TABLE_START = /Description of|Particulars/i

const TABLE_END = new RegExp(
  [
    String.raw`^Amount Chargeable`,
    String.raw`^HSN/SAC`,
    String.raw`^Tax Amount`,
    String.raw`^Company['’]s PAN`,
    String.raw`^Declaration`,
    // The totals row, which always carries money — not Kain's note line
    // "TOTAL NO OF BOXES - 229 BOXES X 36 NOS", which used to end the table
    // one row early.
    String.raw`^Total\b(?=.*${MONEY})`,
    String.raw`^(Output|OUTPUT)\s+(IGST|CGST|SGST)`,
    String.raw`^continued to page`,
    String.raw`^This is a Computer`,
    String.raw`^Subject to`,
    String.raw`^E\. ?& ?O\.E`,
  ].join("|"),
  "i"
)

const SERIAL = /^\s*(\d+)\s+\S/

const BATCH = /Batch\s*(?:no)?\s*[:\-]\s*(\S+)/i
const MFG_DATE = /Mfg\s*Dt\.?\s*:\s*(.+?)\s*$/i
const EXPIRY = /Expiry\s*:\s*(.+?)\s*$/i
const EXPLICIT_SKU = /\bSKU(?:\s*CODE)?\s*[:\-]+\s*(\S+)/i
const LEADING_CODE = /^([A-Za-z]{2,}[A-Za-z0-9]*\d[A-Za-z0-9]*)(?=[_,\s(]|$)/

function num(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw.replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

function skuCodeFrom(block: string[], description: string): string | null {
  for (const line of block) {
    const explicit = line.match(EXPLICIT_SKU)
    if (explicit) return explicit[1].replace(/[.,;]+$/, "")
  }
  return description.match(LEADING_CODE)?.[1] ?? null
}

function itemFrom(block: string[]): ParsedLineItem | null {
  let match: RegExpMatchArray | null = null
  let valueIndex = -1

  for (let i = 0; i < block.length; i++) {
    const found = block[i].match(ROW)
    if (found) {
      match = found
      valueIndex = i
      break
    }
  }
  if (!match?.groups || valueIndex === -1) return null

  const { amount, rate, qty, rest } = match.groups

  const head = block
    .slice(0, valueIndex)
    .concat(block[valueIndex].slice(0, match.index ?? 0))
    .join(" ")
    .replace(SERIAL, (m) => m.replace(/\d+/, ""))
    .replace(/\s+/g, " ")
    .replace(/[(),]+\s*$/, "")
    .trim()

  const tail = block.slice(valueIndex + 1)

  const description = head || null

  return {
    sku_code: skuCodeFrom(block, head),
    sku_name: description,
    batch: block.map((l) => l.match(BATCH)?.[1]).find(Boolean) ?? null,
    mfg_date: tail.map((l) => l.match(MFG_DATE)?.[1]).find(Boolean) ?? null,
    expiry: tail.map((l) => l.match(EXPIRY)?.[1]).find(Boolean) ?? null,
    qty: num(qty),
    hsn: rest.match(/(\d{6,8})(?!.*\d{6,8})/)?.[1] ?? null,
    rate: num(rate),
    mrp: num(rest.match(/(\d[\d,]*\.\d{2})\s*\//)?.[1]),
    discount: null,
    amount: num(amount),
    gst_percent: num(rest.match(/(\d{1,2}(?:\.\d+)?)\s*%/)?.[1]),
    total_amount: null,
  }
}

/**
 * The item table split into one block per numbered row. Exported so the parse
 * gate can compare how many rows the supplier numbered against how many we
 * managed to read.
 */
export function tallyBlocks(text: string): string[][] {
  const lines = text.split(/\r?\n/)

  const start = lines.findIndex((l) => TABLE_START.test(l))
  if (start === -1) return []

  const blocks: string[][] = []
  let current: string[] | null = null
  let expected = 1
  // A multi-page invoice reprints the whole letterhead between one page's
  // footer and the next page's table header. ZYMO's address starts "3 rd
  // floor," there, which reads as row 3 — so rows only count inside the table.
  let inTable = true

  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    if (!line) continue

    if (TABLE_END.test(line)) {
      current = null
      inTable = false
      continue
    }

    if (TABLE_START.test(line)) {
      current = null
      inTable = true
      continue
    }

    // Serials run 1, 2, 3… Anything else opening with a number belongs to the
    // row it follows — a description wrapping onto "200 ml", a pack line
    // "24 X 267 BOX = 6408 NOS", an e-Way row starting with its HSN. Splitting
    // on those stranded the description in one block and the money in the next.
    if (inTable && Number(line.match(SERIAL)?.[1]) === expected) {
      current = [line]
      blocks.push(current)
      expected++
      continue
    }

    current?.push(line)
  }

  return blocks
}

export function parseTallyRows(text: string): ParsedLineItem[] {
  return tallyBlocks(text).map(itemFrom).filter((item): item is ParsedLineItem => item !== null)
}
