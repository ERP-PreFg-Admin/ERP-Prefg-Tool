import { IST } from "@/lib/date"

export const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0

export const fmtInt = (v: string | number | null | undefined) =>
  num(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })

export const fmtMoney = (v: string | number | null | undefined) => {
  const n = num(v)
  if (n === 0) return "—"
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  return `₹${n.toLocaleString("en-IN")}`
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-CA", { timeZone: IST }) : "—"

/** This month plan as a % of monthly capacity — used for the "X% utilised" badge and fill rate. */
export function fillRate(thisMonthPlan: number, capacity: number): number {
  return capacity > 0 ? Math.round((thisMonthPlan / capacity) * 100) : 0
}

// Categorical palette (blue, aqua, yellow, green, violet, red, magenta, orange).
// Fixed hue order — assigned by row position, never re-sorted by value, so a
// manufacturer keeps its color as the underlying data changes. Written as
// complete literal class strings (not built via template interpolation) so
// Tailwind's static scanner can find and generate each utility.
const SERIES_BAR_CLASSES = [
  "bg-[#2a78d6] dark:bg-[#3987e5]", // blue
  "bg-[#1baf7a] dark:bg-[#199e70]", // aqua
  "bg-[#eda100] dark:bg-[#c98500]", // yellow
  "bg-[#008300] dark:bg-[#008300]", // green
  "bg-[#4a3aa7] dark:bg-[#9085e9]", // violet
  "bg-[#e34948] dark:bg-[#e66767]", // red
  "bg-[#e87ba4] dark:bg-[#d55181]", // magenta
  "bg-[#eb6834] dark:bg-[#d95926]", // orange
]

/** Tailwind classes for the categorical bar at this index — fixed hue order, cycles past 8. */
export function seriesBarClass(index: number): string {
  return SERIES_BAR_CLASSES[index % SERIES_BAR_CLASSES.length]
}
