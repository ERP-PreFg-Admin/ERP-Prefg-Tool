import type { ParsedLineItem } from "@/types/invoice"

/**
 * The e-Way bill's "3. Goods Details" table is a second printing of the same
 * lines, so it can both check the item table's parse and supply a description
 * the item table lost. Absent on 7 of 15 sample invoices — absence is not a
 * failure, there is simply nothing to check against.
 */

const SECTION_START = /^3\.\s*Goods Details/i
const SECTION_END = /^4\.\s*Transportation|^Tot\.Taxable Amt/i
const HEADER = /^HSN\b|^Code\s*\(/i

// The value tail: <rate><amount><unit><qty> run together, e.g.
// "184,05,690.48NOS6,408", or Kain's CGST+SGST "9+93,96,477.83NOS8,263".
// ponytail: the rate is taken greedily as 1-2 digits, which splits every real
// sample correctly. A 5% invoice could mis-split — then the amounts stop
// pairing and the invoice falls to Nanonets rather than being read wrong.
const VALUE = /(\d{1,2}(?:\.\d+)?(?:\+\d{1,2}(?:\.\d+)?)?)(\d[\d,]*\.\d{2})([A-Za-z]+)([\d,]+(?:\.\d+)?)\s*$/

const LEADING_HSN = /^\d{4,8}\s+/
// Same shape the item table uses, so a repaired row yields the same code.
const LEADING_CODE = /^([A-Za-z]{2,}[A-Za-z0-9]*\d[A-Za-z0-9]*)(?=[_,\s(]|$)/

const num = (raw: string) => Number(raw.replace(/,/g, ""))

export type EwayGoodsRow = { name: string; amount: number; unit: string; qty: number }

// "Tot.Taxable Amt : 15,12,170.00 Other Amt : 0.39 17,84,361.00Total Inv Amt :"
// The total is taken as the money glued to "Total Inv Amt" rather than by
// position — Aroma prints no "Other Amt" value, so counting fields is wrong.
const EWAY_TAXABLE = /Tot\.Taxable Amt\s*:\s*\(?-?\)?\s*([\d,]+\.\d{2})/i
const EWAY_TOTAL = /([\d,]+\.\d{2})\s*Total Inv Amt/i

/** The e-Way bill's own totals, a second printing of the invoice's own. */
export function parseEwayTotals(text: string): { taxable: number | null; total: number | null } {
  const taxable = text.match(EWAY_TAXABLE)?.[1]
  const total = text.match(EWAY_TOTAL)?.[1]
  return { taxable: taxable ? num(taxable) : null, total: total ? num(total) : null }
}

/** The column is "Product Name & Desc" — name and description joined by " & ". */
function goodsName(head: string): string {
  return head.replace(LEADING_HSN, "").split(" & ")[0].replace(/\s+/g, " ").trim()
}

export function parseEwayGoods(text: string): EwayGoodsRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const start = lines.findIndex((l) => SECTION_START.test(l))
  if (start === -1) return []

  const rows: EwayGoodsRow[] = []
  let head: string[] = []

  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break
    if (HEADER.test(line)) continue

    // A row ends at its value tail; everything since the last one is its name,
    // which wraps over up to three lines depending on how long it is.
    const value = line.match(VALUE)
    if (!value) { head.push(line); continue }

    head.push(line.slice(0, value.index))
    rows.push({
      name: goodsName(head.join(" ")),
      amount: num(value[2]),
      unit: value[3],
      qty: num(value[4]),
    })
    head = []
  }

  return rows
}

/**
 * Cross-check the parsed lines against the e-Way goods table, repairing a
 * description the item table failed to read. Returns a rejection reason, or
 * null when the two agree (or there is no e-Way bill to compare with).
 *
 * Pairs on amount: it is the one field that means the same thing in both
 * tables. Quantity does not — Aroma's e-Way says "BOX 19" where the item
 * table bills pieces.
 */
export function applyEwayGoods(items: ParsedLineItem[], text: string): string | null {
  const rows = parseEwayGoods(text)
  if (rows.length === 0) return null

  if (rows.length !== items.length) {
    return `${items.length} line items read, but the e-Way bill lists ${rows.length} goods rows`
  }

  const unclaimed = [...rows]
  for (const item of items) {
    const at = unclaimed.findIndex((r) => item.amount != null && Math.abs(r.amount - item.amount) < 1)
    if (at === -1) return `no e-Way goods row matches the line amount ${item.amount}`
    const [row] = unclaimed.splice(at, 1)

    // A line with no code read is one whose description the item table lost —
    // take the e-Way bill's, which names the same goods. A line that DID yield
    // a code is left alone even when the two names differ: Ananya prints two
    // codes in the item table and only one in the e-Way bill, and matchSku
    // wants both.
    if (!item.sku_code) {
      item.sku_name = row.name
      item.sku_code = row.name.match(LEADING_CODE)?.[1] ?? null
    }
  }

  return null
}
