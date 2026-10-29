// Computed columns appended to contract v1 (docs/reporting/views-plan.md A5). Pure.

/** Shelf life left at receipt below this many months reads as short-dated (views-plan D4). */
export const SHORT_DATED_MONTHS = 12

const ymIndex = (ym: string | null | undefined): number | null => {
  const m = ym?.match(/^(\d{4})-(\d{2})$/)
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null
}

/** Whole months from `fromYm` to `toYm` (both `YYYY-MM`); null if either is missing. */
export function monthsBetween(fromYm: string | null | undefined, toYm: string | null | undefined): number | null {
  const a = ymIndex(fromYm)
  const b = ymIndex(toYm)
  return a == null || b == null ? null : b - a
}

/** Earliest parseable month among ` / `-joined months (T2 can carry several). */
export function earliestYm(joined: string | null | undefined): string | null {
  const yms = (joined ?? "").split(" / ").filter((y) => ymIndex(y) != null).sort()
  return yms[0] ?? null
}

/** Shelf life left at receipt, and whether that is short-dated. */
export function shelfLife(expiryYm: string | null | undefined, receivedOn: string | null | undefined) {
  const months = monthsBetween(receivedOn ? receivedOn.slice(0, 7) : null, expiryYm)
  return { months, shortDated: months != null && months < SHORT_DATED_MONTHS }
}

/** Whole days between two `YYYY-MM-DD…` values; null if either is missing. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const ms = Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null
}

/** rejected / arrived × 100; null when nothing arrived. */
export const rejectionPct = (rejected: number | null, arrived: number | null): number | null =>
  arrived ? ((rejected ?? 0) / arrived) * 100 : null
