// Shared number formatting and emphasis for the four observability tabs, so a
// latency figure means the same thing — and wears the same colour — on all of
// them. Colour is the scarce signal here: it is spent only on thresholds
// someone would act on.

/** Quiet by default. 300ms is where a request stops feeling instant, 1s is the
 *  Phase 2 slow threshold, 5s is someone watching a spinner. */
export function latencyClass(v: number | null): string {
  if (v === null) return "text-muted-foreground"
  if (v >= 5000) return "text-destructive font-medium"
  if (v >= 1000) return "text-amber-700 dark:text-amber-400"
  if (v >= 300) return "text-foreground"
  return "text-muted-foreground"
}

/** Error rate, as a percentage. Anything at all is worth reading; 1% is worth
 *  looking into; 5% is broken. */
export function rateClass(pct: number): string {
  if (pct >= 5) return "text-destructive font-medium"
  if (pct >= 1) return "text-amber-700 dark:text-amber-400"
  if (pct > 0) return "text-foreground"
  return "text-muted-foreground"
}

/** Host utilisation. Disk and memory are the ones that end in an outage. */
export function utilClass(pct: number): string {
  if (pct >= 90) return "text-destructive font-medium"
  if (pct >= 75) return "text-amber-700 dark:text-amber-400"
  return "text-foreground"
}

/** Seconds past a second: "82ms", "8.4s", "1m 56s". Sorting stays on the raw
 *  millisecond value, so a mixed-unit column still orders correctly. */
export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—"
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`
  const mins = Math.floor(v / 60_000)
  return `${mins}m ${Math.round((v % 60_000) / 1000)}s`
}

export const pct = (v: number, dp = 1) => `${v.toFixed(dp)}%`

export const count = (v: number) => v.toLocaleString("en-IN")

/** Compact elapsed time — "just now", "4m", "3h", "2d". A timestamp answers
 *  "when"; this answers "is it still happening", which is the live question. */
export function ago(at: Date | string | null | undefined): string {
  if (!at) return "—"
  const then = new Date(at).getTime()
  if (Number.isNaN(then)) return "—"
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return "just now"
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86_400)}d`
}

/** min / max across a series, for a sparkline's range caption. Empty in, nulls
 *  out, so the caller can render a dash rather than "Infinity". */
export function range(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}
