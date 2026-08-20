export const MONEY = String.raw`\d[\d,]*\.\d{2}`

export function clean(s: string | null | undefined): string | null {
  const out = (s ?? "").trim()
  return out.length ? out : null
}

export function num(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = Number(String(raw).replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

export function toLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** dd/mm/yyyy as printed by the non-Tally systems, normalised to the dd-mmm-yy
 *  that toDateInputValue already understands. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function slashDateToTally(raw: string | null | undefined): string | null {
  const m = String(raw ?? "").match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/)
  if (!m) return null

  const [, dd, mm, yyyy] = m
  const month = MONTHS[Number(mm) - 1]
  if (!month) return null

  return `${Number(dd)}-${month}-${yyyy.slice(-2)}`
}
