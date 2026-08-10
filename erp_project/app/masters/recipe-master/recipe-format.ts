/**
 * Small formatting/display helpers shared across the Recipe master list, detail
 * panel, and table. Kept dependency-free (no client hooks) so they can be
 * imported from server or client code alike.
 */

import { IST } from "@/lib/date"

export function formatDate(val: Date | string | null) {
  if (!val) return "—"
  const d = typeof val === "string" ? new Date(val) : val
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST })
}

/** Date + time, for audit-trail displays (History page) where the date alone isn't enough. */
export function formatDateTime(val: Date | string | null) {
  if (!val) return "—"
  const d = typeof val === "string" ? new Date(val) : val
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: IST })
}

/** yyyy-mm-dd for <input type="date">. */
export function formatDateInput(val: Date | string | null) {
  if (!val) return ""
  const d = typeof val === "string" ? new Date(val) : val
  if (Number.isNaN(d.getTime())) return ""
  return d.toISOString().slice(0, 10)
}

export const LOCKED_STATUSES = new Set(["in_review", "in review"])
