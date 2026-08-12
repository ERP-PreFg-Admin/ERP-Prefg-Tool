// Invoice-level charges — freight, packing, insurance, handling.

import type { ParsedCharge } from "@/types/invoice"
export type { ParsedCharge }

const CHARGE_LABELS = [
  /freight(\s+charges?)?/i,
  /transport(ation)?\s+charges?/i,
  /packing\s*(&|and)?\s*forwarding/i,
  /packing\s+charges?/i,
  /insurance(\s+charges?)?/i,
  /(un)?loading\s+charges?/i,
  /handling\s+charges?/i,
  /courier\s+charges?/i,
]

/** Lines that carry an amount but must never count as a charge. */
const NOT_A_CHARGE = /\b([CIS]GST|UTGST|CESS|round\s*off|total|taxable|tax\s+amount|e\.?\s*&\s*o\.?e)\b/i

/**
 * The first rupee amount on the line.
 */
function firstAmount(line: string): number | null {
  const m = line.match(/(\d[\d,]*\.\d{2})(?!\d*\.\d)/)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ""))
  return Number.isFinite(n) && n > 0 ? n : null
}

const money = (s: string) => Number(s.replace(/,/g, ""))

/** The SAC printed immediately after the amount ("7,000.00996511"). */
function sacOn(line: string): string | null {
  const m = line.match(/\d[\d,]*\.\d{2}(\d{6,8})\b/)
  return m ? m[1] : null
}

type TaxRow = { taxable: number; tax: number; ratePct: number }

/**
 * The HSN/SAC tax summary — a second statement of the same money, which is what
 * makes verifying a charge possible rather than trusting one parsed line.
 *
 *   HSN/SAC  TotalTax   SGST  Rate  CGST  Rate   TaxableValue
 *   996511   1,260.00   630.00 9%   630.00 9%    7,000.00
 *
 * Read as: code first, total tax next, taxable value last. The intervening
 * columns differ between IGST and CGST+SGST invoices, so they are skipped
 * rather than modelled.
 */
export function parseTaxSummary(text: string): Map<string, TaxRow> {
  const rows = new Map<string, TaxRow>()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // Anchored on a leading HSN/SAC code, which also excludes the "Total" row.
    const m = line.match(/^(\d{6,8})\s+(\d[\d,]*\.\d{2}).*?(\d[\d,]*\.\d{2})$/)
    if (!m) continue

    const tax = money(m[2])
    const taxable = money(m[3])
    if (!(taxable > 0)) continue

    // Rounded to the nearest whole percent: GST rates are whole numbers, and the
    // division carries rounding from per-line paise.
    rows.set(m[1], { taxable, tax, ratePct: Math.round((tax / taxable) * 100) })
  }

  return rows
}

/**
 * Charge lines from an invoice's text.
 */
export function parseCharges(text: string): ParsedCharge[] {
  const out: ParsedCharge[] = []
  const summary = parseTaxSummary(text)

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || NOT_A_CHARGE.test(line)) continue

    const label = CHARGE_LABELS.find((re) => re.test(line))
    if (!label) continue

    const amount = firstAmount(line)
    if (amount == null) continue

    // Cross-check against the tax summary: the same SAC should report the same
    // taxable value. When it does, the amount is confirmed by a second place on
    // the invoice and its real GST rate comes with it — no borrowing the goods
    // rate, no assuming 18%.
    const sac = sacOn(line)
    const row = sac ? summary.get(sac) : undefined
    const verified = !!row && Math.abs(row.taxable - amount) < 1

    out.push({
      label: line.replace(/\s*\d[\d,]*\.\d{2}.*$/, "").trim() || "Charge",
      amount,
      sac,
      gst_percent: verified ? row!.ratePct : null,
      tax_amount:  verified ? row!.tax     : null,
      verified,
    })
  }

  return out
}

/** Total of every charge, for the reconciliation sum. */
export function chargesTotal(charges: ParsedCharge[]): number {
  return charges.reduce((s, c) => s + c.amount, 0)
}
