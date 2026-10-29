// Exception inbox (views-plan B8): the types it gathers, where each comes from, and who may see it. Pure.

export const EXCEPTION_TYPES = [
  "batch_not_received", "batch_short", "batch_not_billed", "grn_unlinked", "short_dated",
  "receipt_without_invoice", "rate_over_po", "invoice_mismatch", "data_quality",
] as const
export type ExceptionType = (typeof EXCEPTION_TYPES)[number]

export const EXCEPTION_META: Record<ExceptionType, { label: string; source: string; needs: "inwarding" | "fg" | "dq" }> = {
  batch_not_received: { label: "Batch billed, not received", source: "Batch ledger", needs: "inwarding" },
  batch_short: { label: "Batch short-received", source: "Batch ledger", needs: "inwarding" },
  batch_not_billed: { label: "GRN batch not on the invoice", source: "Batch ledger", needs: "inwarding" },
  grn_unlinked: { label: "GRN line not linked to a PO", source: "GRN lines", needs: "inwarding" },
  short_dated: { label: "Short-dated at receipt", source: "Batch ledger", needs: "inwarding" },
  receipt_without_invoice: { label: "Received without an invoice", source: "PO receipt ledger", needs: "fg" },
  rate_over_po: { label: "Billed above PO rate", source: "Invoice checks · Rate vs PO", needs: "inwarding" },
  invoice_mismatch: { label: "Invoice doesn't match (PO / total / GRN)", source: "Invoice checks", needs: "inwarding" },
  data_quality: { label: "Data-quality check", source: "Data quality", needs: "dq" },
}

export type ExceptionRow = {
  type: ExceptionType
  label: string
  /** What to trace: a PO no., invoice no., SKU or batch. */
  ref: string
  detail: string
  mfg_code: string | null
  age_days: number | null
  /** ₹ when the source has a price, otherwise units; never mixed. */
  value: number | null
  value_unit: "inr" | "units" | "count"
  source: string
}

export type ExceptionFilter = {
  type: ExceptionType | null; q: string | null; minAge: number | null; minValue: number | null
  /** YYYY-MM-DD on the day the problem started (today − age); undated items drop out once a date is set. */
  dateFrom?: string | null; dateTo?: string | null
}

const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/** URL → inbox filter, shared by the page and its export. */
export function parseExceptionFilter(sp: Record<string, string | string[] | undefined>): ExceptionFilter {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const num = (v: unknown) => { const x = Number(s(v)); return s(v) != null && Number.isFinite(x) ? x : null }
  const t = s(sp.type)
  const day = (v: unknown) => { const x = s(v); return x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null }
  return {
    type: t && (EXCEPTION_TYPES as readonly string[]).includes(t) ? (t as ExceptionType) : null,
    q: s(sp.q), minAge: num(sp.age), minValue: num(sp.min), dateFrom: day(sp.from), dateTo: day(sp.to),
  }
}

/** Search matches record, detail or problem; min value applies to ₹ items only (units and counts have no price). */
export function filterExceptions(rows: readonly ExceptionRow[], f: ExceptionFilter, today: string = istToday()): ExceptionRow[] {
  const needle = f.q?.toLowerCase() ?? null
  // A start date maps to an age band: from → at most that many days old, to → at least.
  const maxAge = f.dateFrom ? daysBetween(f.dateFrom, today) : null
  const minAgeTo = f.dateTo ? daysBetween(f.dateTo, today) : null
  const dated = (r: ExceptionRow) => (maxAge == null && minAgeTo == null) ||
    (r.age_days != null && (maxAge == null || r.age_days <= maxAge) && (minAgeTo == null || r.age_days >= minAgeTo))
  return rows.filter((r) =>
    (!f.type || r.type === f.type) &&
    (!needle || `${r.ref} ${r.detail} ${r.label}`.toLowerCase().includes(needle)) &&
    (f.minAge == null || (r.age_days ?? -1) >= f.minAge) && dated(r) &&
    (f.minValue == null || (r.value_unit === "inr" && (r.value ?? 0) >= f.minValue)))
}

/** Money first (largest first), then units, then counts; oldest first within a tie. */
export function sortExceptions(rows: ExceptionRow[]): ExceptionRow[] {
  const rank = { inr: 0, units: 1, count: 2 } as const
  return [...rows].sort((a, b) =>
    rank[a.value_unit] - rank[b.value_unit] || (b.value ?? 0) - (a.value ?? 0) || (b.age_days ?? 0) - (a.age_days ?? 0))
}
