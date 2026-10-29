// Text normalisers for the traceability datasets (docs/reporting/dataset-contracts.md). Pure.

/** Loose batch key: uppercase, without spaces, dashes, slashes, dots or underscores. */
export function batchKey(raw: string | null | undefined): string {
  const k = (raw ?? "").toUpperCase().replace(/[\s\-/._]/g, "")
  return k || "(no batch)"
}

/** SKU join key, same rule as skuKey in lib/invoice/three-way.ts (SQL collation is case-blind). */
export const skuKey = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/** exact when some spelling appears verbatim (after trim) on both sides; loose when only the key agrees. */
export function batchMatch(invoiceRaws: readonly string[], grnRaws: readonly string[]): "exact" | "loose" | null {
  if (invoiceRaws.length === 0 || grnRaws.length === 0) return null
  const inv = new Set(invoiceRaws.map((b) => b.trim()))
  return grnRaws.some((b) => inv.has(b.trim())) ? "exact" : "loose"
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
}
const ym = (y: number, m: number) =>
  y >= 1990 && y <= 2100 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}` : null
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))

/**
 * Expiry / mfg date → `YYYY-MM`, or null when it can't be read.
 * Covers what invoices print (Jun-2026, JUNE 26, 06/2026, 15/06/2026) and what Uniware sends (ISO, epoch ms).
 */
export function toYm(raw: string | number | null | undefined): string | null {
  if (raw == null) return null
  const s = String(raw).trim().toUpperCase()
  if (!s) return null

  if (/^\d{11,13}$/.test(s)) {
    // Epoch ms; read in IST, the zone Uniware's dates are entered in.
    const d = new Date(Number(s) + 5.5 * 3_600_000)
    return Number.isNaN(d.getTime()) ? null : ym(d.getUTCFullYear(), d.getUTCMonth() + 1)
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[T\s].*)?$/) // 2026-06, 2026-06-15
  if (m) return ym(Number(m[1]), Number(m[2]))
  m = s.match(/^\d{1,2}[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/) // 15/06/2026
  if (m) return ym(fullYear(m[2]), Number(m[1]))
  m = s.match(/^(\d{1,2})[-/.](\d{4}|\d{2})$/) // 06/2026, 06-26
  if (m) return ym(fullYear(m[2]), Number(m[1]))
  m = s.match(/^([A-Z]{3,9})[\s\-/.,']*(\d{4}|\d{2})$/) // JUN-2026, JUNE 26
  if (m) {
    const mon = MONTHS[m[1].slice(0, m[1] === "SEPT" ? 4 : 3)] ?? MONTHS[m[1].slice(0, 3)]
    return mon ? ym(fullYear(m[2]), mon) : null
  }
  m = s.match(/^\d{1,2}[\s\-/.]([A-Z]{3,9})[\s\-/.,']*(\d{4}|\d{2})$/) // 15-JUN-2026
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3)]
    return mon ? ym(fullYear(m[2]), mon) : null
  }
  return null
}

/** Printed-line reference: FIFO rows of one printed line share it (contracts T1). */
export function printedLineRef(l: {
  invoice_no: string; sku_code: string | null; batch: string | null; expiry: string | null; rate: number | string | null
}): string {
  return [l.invoice_no, skuKey(l.sku_code), batchKey(l.batch), (l.expiry ?? "").trim(), l.rate == null ? "" : Number(l.rate)]
    .join(" · ")
}
