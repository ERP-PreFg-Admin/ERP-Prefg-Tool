// Shared bits for the traceability services: number/date coercion and the view scope.

import { isoDate, todayIST } from "@/lib/date"
import { timedQuery } from "@/lib/query-timing"

/** How a service reads. Defaults to the pool; DB tests pass their rolled-back connection. */
export type Run = (sql: string, params: unknown[], label: string) => Promise<Record<string, unknown>[]>
export const poolRun: Run = (sql, params, label) => timedQuery<Record<string, unknown>>(sql, params, { label })

export const num = (v: unknown): number => (v == null ? 0 : Number(v))
export const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))
export const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v))

/** UTC instant → `YYYY-MM-DD HH:mm` IST; empty for null. */
export function istStamp(v: unknown): string | null {
  if (!v) return null
  const d = new Date(v as string | Date)
  if (Number.isNaN(d.getTime())) return null
  const ist = new Date(d.getTime() + 5.5 * 3_600_000).toISOString()
  return `${ist.slice(0, 10)} ${ist.slice(11, 16)}`
}

/** UTC instant → IST `YYYY-MM-DD`. */
export const istDay = (v: unknown): string | null => (v ? todayIST(new Date(v as string | Date)) : null)

/** A DATE column → `YYYY-MM-DD`. */
export const day = (v: unknown): string | null => isoDate(v as Date | string | null) || null

/** Invoice numbers compared loosely: letters and digits only, uppercased. */
export const invoiceKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
