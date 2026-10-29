"use client"

import { X } from "lucide-react"
import { useUrlFilters } from "@/lib/useUrlFilters"

// Active filters as removable chips, so what's filtered is visible without opening the panel.
export default function FilterChips({ labels }: { labels: Record<string, string> }) {
  const { navigate, searchParams } = useUrlFilters()
  const active = Object.keys(labels).filter((k) => searchParams.get(k))
  if (active.length === 0) return null

  // Removing the invoice filter also drops its exact-match flag, so nothing invisible stays applied.
  const clear = (k: string) => navigate(k === "inv" ? { inv: "", exact: "" } : { [k]: "" })
  const shown = (k: string) => {
    const v = searchParams.get(k) ?? ""
    return k === "overdue" || k === "active" || k === "month" ? "on" : v.replace(/_/g, " ")
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Active filters">
      {active.map((k) => (
        <button key={k} type="button" onClick={() => clear(k)}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Remove filter ${labels[k]}: ${shown(k)}`}>
          <span className="text-muted-foreground">{labels[k]}:</span>
          <span className="font-mono">{shown(k)}</span>
          <X className="h-3 w-3" />
        </button>
      ))}
      {active.length > 1 && (
        <button type="button" onClick={() => navigate(Object.fromEntries(active.map((k) => [k, ""])))}
          className="text-xs text-primary underline-offset-4 hover:underline">
          Clear all
        </button>
      )}
    </div>
  )
}
