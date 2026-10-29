// Month-grained reports (fill rate, scorecard) shown in the app's date range picker. Pure.

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
}

/** YYYY-MM pair → the picker's first and last day; empty stays empty. */
export function monthBounds(from: string | null, to: string | null): { from: string; to: string } {
  return { from: from ? `${from.slice(0, 7)}-01` : "", to: to ? lastDayOfMonth(to.slice(0, 7)) : "" }
}
