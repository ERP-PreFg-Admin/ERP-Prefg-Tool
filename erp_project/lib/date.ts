/**
 * Indian Standard Time, everywhere the app says "today", "this month" or shows
 * a clock time.
 *
 * Neither clock underneath is IST: RDS runs `time_zone = UTC` (so `NOW()` and
 * `CURDATE()` are UTC) and the container's own zone is whatever the Dockerfile
 * says. Rather than pick a winner, the rule is:
 *
 *   - timestamps are STORED as UTC instants — the one unambiguous choice, and
 *     what mysql2 already assumes via `timezone: "+00:00"` in lib/db.ts;
 *   - every date boundary and every rendered time is converted to IST *here*,
 *     explicitly, instead of being inherited from whichever host is running.
 *
 * The explicit `timeZone` matters even with `TZ=Asia/Kolkata` set in the
 * Dockerfile: it keeps a laptop with a wrong system clock zone, a CI runner, or
 * a future deploy target from quietly changing what "today" means.
 */

export const IST = "Asia/Kolkata"

/** en-CA is the locale that formats as `YYYY-MM-DD`. */
const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/**
 * Today in IST as `YYYY-MM-DD`.
 *
 * Never `new Date().toISOString().slice(0, 10)` — that is the *UTC* date, which
 * is still yesterday until 05:30 IST. It read correctly on a developer laptop
 * in India and wrongly in the UTC container, which is why it survived so long.
 *
 * Takes the instant as an argument so the 00:00–05:30 window is testable.
 */
export function todayIST(at: Date = new Date()): string {
  return ymd.format(at)
}

/** The current month in IST as `YYYY-MM` — used for S3 upload folder names. */
export function monthIST(at: Date = new Date()): string {
  return todayIST(at).slice(0, 7)
}

/**
 * `CURDATE()` in IST, for interpolating into SQL.
 *
 * The DB session is UTC, so a plain `CURDATE()` rolls the day over 5½ hours
 * late: a PO raised at 02:00 IST would be dated yesterday. Numeric offsets are
 * used instead of the name 'Asia/Kolkata' because named zones need the mysql
 * time-zone tables loaded, which this RDS instance does not have.
 */
export const SQL_TODAY_IST = "DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30'))"

// ── Calendar grid math, for components/ui/date-picker.tsx ────────────────────
//
// Lives here rather than in a `lib/date-range.ts` because a second date module
// would mean two answers to "what is today", which is the exact failure this
// file's header warns about. `todayIST` above is reused, not re-implemented.

/** Monday-first: the picker is for an Indian business week. */
export const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

/**
 * `"2026-08-25"` → `{ y: 2026, m: 8, d: 25 }`; `null` for empty or malformed.
 *
 * Splits the string rather than calling `new Date(iso)`: a bare ISO date parses
 * as UTC *midnight*, so reading it back with local getters returns the previous
 * day for anyone west of Greenwich, and the wrong month at a month boundary.
 * Same class of bug as the one documented at the top of this file.
 */
export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "")
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12) return null
  if (d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

export function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/**
 * Day 0 of month `m + 1` is the last day of month `m`. `m` is 1-based here and
 * 0-based in `Date`, so passing `m` already means "the following month".
 * Built from explicit UTC components and read with `getUTCDate` — no string
 * parsing, so no timezone can shift it.
 */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Monday-first weekday index (0 = Mon … 6 = Sun) of the 1st of the month. */
function firstWeekdayMondayFirst(y: number, m: number): number {
  const sundayFirst = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  return (sundayFirst + 6) % 7
}

/**
 * One month as 6 rows × 7 columns of ISO dates; `null` is padding either side.
 *
 * Always 6 rows even when 5 would fit, so the popover does not change height as
 * you page through months — a jumping popover moves the day you were aiming at
 * out from under the cursor.
 */
export function monthMatrix(y: number, m: number): (string | null)[][] {
  const lead = firstWeekdayMondayFirst(y, m)
  const cells: (string | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth(y, m) }, (_, i) => toIso(y, m, i + 1)),
  ]
  while (cells.length < 42) cells.push(null)
  return Array.from({ length: 6 }, (_, r) => cells.slice(r * 7, r * 7 + 7))
}

/** Month arithmetic in a flat month-count, so year rollover is not a special case. */
export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const flat = y * 12 + (m - 1) + delta
  return { y: Math.floor(flat / 12), m: (flat % 12) + 1 }
}

/**
 * Which month the calendar should open on: the first parseable candidate
 * (current value, then `min`), falling back to today in IST. Never null — the
 * picker always has a month to render.
 */
export function anchorMonth(...candidates: string[]): { y: number; m: number } {
  for (const c of candidates) {
    const p = parseIso(c)
    if (p) return { y: p.y, m: p.m }
  }
  const t = parseIso(todayIST())
  return t ? { y: t.y, m: t.m } : { y: 1970, m: 1 }
}

export function monthLabel(y: number, m: number): string {
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** `"2026-08-25"` → `"25 Aug 2026"`. `""` for anything unparseable — a trigger
 *  reading "Invalid Date" is worse than one reading its placeholder. */
export function formatDisplay(iso: string): string {
  const p = parseIso(iso)
  return p ? `${String(p.d).padStart(2, "0")} ${MONTH_NAMES[p.m - 1]} ${p.y}` : ""
}

/** ISO dates sort lexicographically, so string compare is a correct date compare.
 *  An empty operand means "unset", which is never before or after anything. */
export function isBefore(a: string, b: string): boolean {
  return Boolean(a) && Boolean(b) && a < b
}

/** Inclusive at both ends. A half-open selection (`to` empty) contains nothing. */
export function isInRange(iso: string, from: string, to: string): boolean {
  if (!iso || !from || !to) return false
  return iso >= from && iso <= to
}

/** Outside `[min, max]` — both inclusive, both optional. */
export function isDisabledDate(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min) return true
  if (max && iso > max) return true
  return false
}
