"use client"

// The three-way match across EVERY invoice the current filter matches — not the
// page on screen. Its own fetch, because the list route is paginated and a
// summary of 25 rows labelled as a total is worse than no summary.

import { useEffect, useState } from "react"
import { CreditCard, FileText, Package } from "lucide-react"
import { cn } from "@/lib/utils"
import { MATCH_TOLERANCE, type MatchBadge, type MatchSummary } from "@/lib/invoice/three-way"

type Summary = MatchSummary & { truncated: boolean; cap: number }

/** Worst first: what needs doing leads, what is finished trails. */
const BADGES: { key: MatchBadge; label: string; tone: string }[] = [
  { key: "unmatched",             label: "Unmatched",             tone: "text-destructive" },
  { key: "variance",              label: "Variance",              tone: "text-amber-700 dark:text-amber-400" },
  { key: "invoice_matched",       label: "Awaiting documents",    tone: "text-foreground" },
  { key: "awaiting_verification", label: "Awaiting verification", tone: "text-foreground" },
  { key: "fully_matched",         label: "Fully matched",         tone: "text-emerald-700 dark:text-emerald-400" },
]

const LEGS = [
  { key: "po"  as const, label: "PO",  Icon: FileText },
  { key: "inv" as const, label: "INV", Icon: CreditCard },
  { key: "pod" as const, label: "GRN", Icon: Package },
]

export default function ThreeWaySummary({ filterQuery, search, reloadKey }: {
  filterQuery: string
  search: string
  reloadKey: number
}) {
  const [s, setS] = useState<Summary | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(filterQuery)
    if (search.trim()) params.set("search", search.trim())
    void reloadKey
    fetch(`/api/v1/purchase-orders/invoice/summary?${params}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? "Couldn't load the summary.")
        return data as Summary
      })
      .then((d) => { if (!cancelled) { setS(d); setError("") } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the summary.") })
    return () => { cancelled = true }
  }, [filterQuery, search, reloadKey])

  if (error) return <p className="text-xs text-destructive">{error}</p>
  // No skeleton: the row below it loads at the same time, and two spinners
  // stacked read as two things being slow.
  if (!s) return <div className="h-14" />

  const { invoices, byBadge, onFile, verified, variance, documentsOnFile, signatures } = s
  const pct = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 100))

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-medium">Three-way match</span>
        <span className="tabular-nums text-muted-foreground">
          {invoices} invoice{invoices === 1 ? "" : "s"} matching these filters
        </span>
        <span className="tabular-nums text-muted-foreground">
          {documentsOnFile} of {invoices * 3} documents on file
        </span>
        <span className="tabular-nums text-muted-foreground">
          {signatures} of {invoices * 3} verified
        </span>
        <span className="ml-auto text-muted-foreground">
          tolerance {(MATCH_TOLERANCE * 100).toFixed(0)}%
        </span>
      </div>

      {/* Per verdict. Zero buckets are dropped — an empty count is noise, and
          the ones that matter should not have to be found among them. */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {BADGES.filter((b) => (byBadge[b.key] ?? 0) > 0).map((b) => (
          <span key={b.key} className="tabular-nums">
            <span className={cn("font-medium", b.tone)}>{byBadge[b.key]}</span>
            <span className="ml-1 text-muted-foreground">{b.label}</span>
          </span>
        ))}
        {invoices === 0 && <span className="text-muted-foreground">No invoices match these filters.</span>}
      </div>

      {/* Per leg: which document is actually holding the set up. The three
          counts answer "chase GRNs" vs "chase signatures" vs "chase nothing". */}
      {invoices > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-2">
          {LEGS.map(({ key, label, Icon }) => (
            <span key={key} className="inline-flex items-baseline gap-1.5 tabular-nums">
              <Icon className="h-3 w-3 shrink-0 translate-y-0.5 text-muted-foreground" />
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground">
                {onFile[key]}/{invoices} on file ({pct(onFile[key], invoices)}%)
              </span>
              <span className="text-muted-foreground">· {verified[key]} verified</span>
              {variance[key] > 0 && (
                <span className="text-amber-700 dark:text-amber-400">· {variance[key]} variance</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Only when the cap bites, so the numbers above are never quietly partial. */}
      {s.truncated && (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
          Summarising the first {s.cap.toLocaleString("en-IN")} invoices only — narrow the filters for an exact figure.
        </p>
      )}
    </div>
  )
}
