import { IST } from "@/lib/date"

export const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0

export const fmtInt = (v: string | number | null | undefined) =>
  num(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })

export const fmtMoney = (v: string | number | null | undefined) => {
  const n = num(v)
  if (n === 0) return "—"
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`
  return `₹${n.toLocaleString("en-IN")}`
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-CA", { timeZone: IST }) : "—"

export const fmtRate = (v: string | number | null | undefined) => {
  const n = num(v)
  if (n === 0) return "—"
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

export const isImpromptu = (po_no: string) => po_no.startsWith("IMP-")

export function getPageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total]
  if (current >= total - 3) return [1, "…", total - 4, total - 3, total - 2, total - 1, total]
  return [1, "…", current - 1, current, current + 1, "…", total]
}
