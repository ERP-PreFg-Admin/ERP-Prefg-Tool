// Canonical Reports definitions (docs/reporting/implementation-plan.md): open, price class, value.
// Pure — no DB import, so tests/unit can load it. SQL that needs RECEIVED_TOTAL_EXPR lives in lib/queries/reports.ts.

import { SPECIAL_PO_TYPES, isSpecialPoType } from "@/lib/po/po-rules"
import { todayIST } from "@/lib/date"

/** Display statuses that count as open: approved, mailed, not closed. */
export const OPEN_STATUSES = ["raised", "punched", "partially_received"] as const

export type PriceClass = "priced" | "unpriced" | "special"

/** SQL twin of priceClass(); expects the PO aliased as `po`. */
export const PRICE_CLASS_SQL = `
  CASE
    WHEN COALESCE(po.po_type, '') IN (${SPECIAL_PO_TYPES.map((t) => `'${t}'`).join(", ")}) THEN 'special'
    WHEN COALESCE(po.unit_price, 0) = 0 THEN 'unpriced'
    ELSE 'priced'
  END
`

type Num = number | string | null | undefined

const n = (v: Num): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export function priceClass(po: { po_type: string | null; unit_price: Num }): PriceClass {
  if (isSpecialPoType(po.po_type)) return "special"
  return n(po.unit_price) === 0 ? "unpriced" : "priced"
}

/** Qty still owed on a master; `received` must already include split children. */
export function openQty(qty: Num, received: Num): number {
  return Math.max(n(qty) - n(received), 0)
}

export function isOpen(displayStatus: string | null, qty: Num, received: Num): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(displayStatus ?? "") && openQty(qty, received) > 0
}

/** Pre-GST value of `qty` units; null for unpriced/special so totals never count them as ₹0. */
export function valuePreGst(po: { po_type: string | null; unit_price: Num }, qty: Num): number | null {
  return priceClass(po) === "priced" ? n(qty) * n(po.unit_price) : null
}

/** GST-inclusive twin of valuePreGst, at the SKU master's current GST rate. */
export function valueInclGst(preGst: number | null, gstPct: Num): number | null {
  return preGst == null ? null : preGst * (1 + n(gstPct) / 100)
}

/** The report's "today": an IST date, passed to SQL instead of CURDATE() (which is UTC). */
export function reportToday(at: Date = new Date()): string {
  return todayIST(at)
}

/** Whole days from an IST `YYYY-MM-DD` to today; null when the date is missing. */
export function ageDays(date: string | null | undefined, today: string): number | null {
  if (!date) return null
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null
}

export function isOverdue(expectedOn: string | null | undefined, today: string): boolean {
  return !!expectedOn && expectedOn.slice(0, 10) < today
}

export const AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]

export function ageBucket(days: number | null): AgeBucket | null {
  if (days == null) return null
  if (days <= 30) return "0-30"
  if (days <= 60) return "31-60"
  if (days <= 90) return "61-90"
  return "90+"
}
