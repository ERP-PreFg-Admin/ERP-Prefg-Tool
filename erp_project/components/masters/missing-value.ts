/**
 * "This master record has a gap here" — shared by every masters table so the
 * cue means the same thing on Material Master and on both Cost Masters.
 *
 * Judged on the ROW's raw value, not on what the column rendered. A column with
 * a custom `render` (a status badge, a formatted date) would otherwise print its
 * own "—" and look identical to a populated cell.
 */

export function isMissingValue(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ""
}

/** Amber wash + amber dash. Deliberately not red: a blank field is data still to
 *  be filled in, not an error — red is reserved for things that are wrong. */
export const MISSING_CELL_CLASS =
  "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
