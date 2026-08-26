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

export const MONTH_NAMES = [
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
 * A date as it arrives FROM THE DATABASE, as the `YYYY-MM-DD` string every
 * helper in this file and every date input expects. `""` when there is none.
 *
 * mysql2 hands a DATE/DATETIME column back as a JS `Date`, not a string. Every
 * row type in `types/masters.ts` declares those columns `string | null` and is
 * wrong about it, and `query<T>` is an unchecked cast so nothing catches the
 * lie. It stayed hidden for as long as dates only ever reached `fmtDate`, which
 * accepts either — but:
 *
 *   - seeding a DatePicker with one makes `parseIso` fail its regex, so the
 *     picker silently shows nothing for a row that has a date;
 *   - rendering one as a React child throws "Objects are not valid as a React
 *     child (found: [object Date])".
 *
 * UTC getters, not local ones: `lib/db.ts` sets `timezone: "+00:00"`, so mysql2
 * builds a DATE as UTC midnight. Local getters would return the previous day
 * for anyone west of Greenwich — the trap documented at the top of this file.
 */
export function isoDate(v: string | Date | null | undefined): string {
  if (v == null) return ""
  if (typeof v === "string") return v.slice(0, 10)
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : ""
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

/**
 * True when EVERY day of this month falls outside min..max, so offering the
 * month in a picker is a dead choice.
 *
 * Compared at the month's edges, not its 1st: a `min` of the 20th still leaves
 * ten selectable days, and disabling that month would make the min date itself
 * unreachable from the month picker.
 */
export function isMonthDisabled(y: number, m: number, min?: string, max?: string): boolean {
  const last = toIso(y, m, daysInMonth(y, m))
  const first = toIso(y, m, 1)
  return Boolean(min && last < min) || Boolean(max && first > max)
}

/**
 * Years offered either side of the view when min/max leave them unbounded.
 *
 * Wide on purpose. The year list scrolls and opens centred on the current year,
 * so the only cost of a far edge is scroll distance nobody travels — whereas a
 * range that stops short is a dead end with no way out of it. ±10 was that dead
 * end: a 2015 historical record and a 2040 contract date were both unreachable.
 */
const YEAR_SPAN = 50

/**
 * The years a calendar's year picker should offer, ascending.
 *
 * Bounded by `min`/`max` when the caller gave them — offering a year whose every
 * day is disabled is a dead end. `viewYear` is always included even when the
 * bounds exclude it, so the header can never name a year the list has no row
 * for.
 */
export function calendarYears(viewYear: number, min?: string, max?: string): number[] {
  const lo = min ? Number(min.slice(0, 4)) : viewYear - YEAR_SPAN
  const hi = max ? Number(max.slice(0, 4)) : viewYear + YEAR_SPAN
  const from = Math.min(lo, viewYear)
  const to = Math.max(hi, viewYear)
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
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

// ── Date cells arriving FROM a CSV / Excel upload ────────────────────────────
//
// Everything above turns a date we already trust into something to render or
// compare. This section is the other direction: text a human typed into a
// spreadsheet, which is formatted for people and not for us.
//
// It corrects rather than rejects. Every bulk importer used to accept strict
// `YYYY-MM-DD` only, which meant an Excel date column formatted as General
// ("45000"), a date cell carrying a time, and the two formats an Indian
// spreadsheet produces by default all came back as "must be YYYY-MM-DD" and
// kept the row out of the upload.

/** First three letters are enough, and are what every locale abbreviates to. */
const MONTH_NUMBERS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Excel's day 1 is 1900-01-01, but it also believes 1900-02-29 existed, so from
 * serial 61 onward — which is every date anyone will ever upload — the epoch
 * that reproduces its arithmetic is 1899-12-30, not 12-31.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

const MS_PER_DAY = 86_400_000

/**
 * A bare number only reads as an Excel serial inside this band — 1954-10-03 to
 * 2064-03-16. Any effective date fits, and a cell holding just a year ("2026")
 * falls outside it, so it is reported as unreadable rather than silently
 * becoming 1905-07-18.
 */
const SERIAL_MIN = 20_000
const SERIAL_MAX = 60_000

/**
 * `y/m/d` as ISO, or `""` if that is not a real date. Every branch of
 * `normalizeDateCell` ends here, so "31-02-2026" returns nothing instead of the
 * plausible-looking "2026-02-31" that a bare string build would produce.
 */
function checkedIso(y: number, m: number, d: number): string {
  const iso = toIso(y, m, d)
  return parseIso(iso) ? iso : ""
}

/** A 2-digit year is this century: "26" is 2026, never 1926. Same call
 *  lib/invoice/invoice-mapping.ts makes for the same reason. */
function fullYear(raw: string): number {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw)
}

/**
 * A date cell from a CSV or Excel import, as `YYYY-MM-DD`. `""` when the text is
 * not a date in any shape we recognise — callers already treat an empty date as
 * "not given" (`|| todayIST()`, `|| null`), so `""` needs no special handling.
 *
 * Accepted, first match winning:
 *
 *   2026-08-26 · 2026/08/26 · 2026.08.26      ISO, any separator
 *   2026-08-26 09:30:00 · 2026-08-26T09:30Z   ISO with a time (Excel date cell)
 *   20260826                                  compact
 *   45000                                     Excel serial, incl. fractional
 *   26-08-2026 · 26/08/2026 · 26.8.26         DAY-first numeric
 *   25-AUg-26 · 25/Aug/2026 · 25 August 26    named month, any case
 *   Aug-25-2026 · August 25, 2026             named month first
 *
 * The one genuinely ambiguous shape is `dd/mm` vs `mm/dd`, and it is resolved
 * DAY-FIRST, always — the rule `toDateInputValue` already took for Indian
 * documents. Never inferred from the values, because a rule that reads
 * 03/04/2026 one way and 04/03/2026 the other is worse than a rule that is
 * merely a convention. "04/13/2026" therefore has no reading and returns "".
 */
export function normalizeDateCell(raw: string | number | null | undefined): string {
  const s = String(raw ?? "").trim()
  if (!s) return ""

  // ISO first — it is what our own templates ask for and what a re-uploaded
  // flagged-rows CSV carries. The optional tail swallows a time component,
  // which is how ExcelJS renders any date cell not at exact UTC midnight.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s)
  if (iso) return checkedIso(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  if (/^\d{8}$/.test(s)) {
    return checkedIso(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)))
  }

  // An Excel serial. Checked after the 8-digit form because 20260826 is a
  // compact date, not a serial — the largest date Excel can hold is 2958465.
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s))
    if (serial < SERIAL_MIN || serial > SERIAL_MAX) return ""
    const at = new Date(EXCEL_EPOCH_MS + serial * MS_PER_DAY)
    return checkedIso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate())
  }

  // Named month, day first: 25-AUg-26, 25/Aug/2026, "25 August 26".
  const named = /^(\d{1,2})[-/. ]+([A-Za-z]{3,})[-/. ]+(\d{2}|\d{4})$/.exec(s)
  if (named) {
    const m = MONTH_NUMBERS[named[2].slice(0, 3).toLowerCase()]
    return m ? checkedIso(fullYear(named[3]), m, Number(named[1])) : ""
  }

  // Named month first: Aug-25-2026, "August 25, 2026", "25th" tolerated.
  const monthFirst = /^([A-Za-z]{3,})[-/. ]+(\d{1,2})(?:st|nd|rd|th)?,?[-/. ]+(\d{2}|\d{4})$/.exec(s)
  if (monthFirst) {
    const m = MONTH_NUMBERS[monthFirst[1].slice(0, 3).toLowerCase()]
    return m ? checkedIso(fullYear(monthFirst[3]), m, Number(monthFirst[2])) : ""
  }

  // All-numeric, day first. Last, so it can never shadow the ISO form above.
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s)
  if (dayFirst) {
    return checkedIso(fullYear(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]))
  }

  return ""
}

/**
 * `MasterField.parse` for a date column: the corrected date, or the cell left
 * exactly as typed when we could not read it.
 *
 * The fallback is what makes "Download flagged rows" usable. An unreadable cell
 * is always flagged by `dateCellRemark` and so never reaches the upload, but
 * blanking it would hand the uploader a CSV with an empty column to fix rather
 * than the text that needs fixing.
 */
export function parseDateCell(raw: string): string {
  return normalizeDateCell(raw) || raw
}

/**
 * The CSV importer's remark for a date cell, or `null` when there is nothing to
 * say. Only text `normalizeDateCell` cannot read at all is worth blocking a row
 * for; every shape it understands is corrected in place, and the corrected value
 * is what the import preview shows.
 */
export function dateCellRemark(raw: string): string | null {
  return normalizeDateCell(raw)
    ? null
    : `is not a date we recognise (got "${raw}") — try YYYY-MM-DD, DD-MM-YYYY or DD-Mon-YYYY`
}
