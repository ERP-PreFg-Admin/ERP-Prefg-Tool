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
