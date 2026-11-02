"use client"

// Sweeps every facility for Uniware POs no ERP invoice owns, one request per facility so each fits maxDuration.
// The result is a short inline list of what needs doing; adoption itself happens in Add Invoice.

import { useState } from "react"
import { Loader2, SearchCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { apiErrorMessage } from "@/lib/api-error-message"
import type { ExternalPoCandidate } from "@/lib/uniware/external-po"

const SHOW = 12

type Summary = { counts: string; lines: string[]; failed: boolean }

function describe(p: ExternalPoCandidate): string | null {
  const where = `${p.uniware_po_code} (${p.mfg_code ?? "?"}, ${p.facility_code}, ref ${p.reference_no ?? "—"})`
  if (p.kind === "replacement") return `Revert ERP invoice ${p.live_invoice_no}, then add it again linked to ${where}`
  if (p.kind === "missing") return `Add Invoice for ${where}`
  if (p.kind === "not_fg") return `Not FG, nothing to do: ${where}`
  return null
}

export default function FindUniwareOnlyButton() {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState("")
  const [summary, setSummary] = useState<Summary | null>(null)

  async function run() {
    setBusy(true)
    setSummary(null)
    try {
      const facRes = await fetch("/api/v1/purchase-orders/uniware-external?facilities=1")
      const facData = await facRes.json().catch(() => ({}))
      if (!facRes.ok) throw new Error(apiErrorMessage(facData, "Couldn't list facilities."))
      const facilities: string[] = facData.facilities ?? []

      const rows = new Map<string, ExternalPoCandidate>()
      const errors: string[] = []
      let partial = false
      for (const [i, facility] of facilities.entries()) {
        setProgress(`${i + 1}/${facilities.length} · ${facility}`)
        const res = await fetch("/api/v1/purchase-orders/uniware-external", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facility }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { errors.push(`${facility}: ${apiErrorMessage(data, "failed")}`); continue }
        if (data.partial) partial = true
        for (const r of (data.rows ?? []) as ExternalPoCandidate[]) rows.set(r.uniware_po_code, r)
      }

      const all = [...rows.values()]
      const n = (k: ExternalPoCandidate["kind"]) => all.filter((r) => r.kind === k).length
      const order: ExternalPoCandidate["kind"][] = ["replacement", "missing", "not_fg"]
      const lines = order.flatMap((k) => all.filter((r) => r.kind === k)).map(describe).filter((l): l is string => !!l)
      setSummary({
        counts: `${n("missing")} to add · ${n("replacement")} to revert and re-add · ${n("not_fg")} not FG` +
          ` · ${n("adopted")} already linked${partial ? " · some facilities cut short, press again" : ""}`,
        lines: [...errors, ...lines.slice(0, SHOW), ...(lines.length > SHOW ? [`+${lines.length - SHOW} more`] : [])],
        failed: errors.length > 0,
      })
    } catch (e: unknown) {
      setSummary({ counts: "Search failed", lines: [e instanceof Error ? e.message : "Couldn't reach Uniware."], failed: true })
    } finally {
      setBusy(false)
      setProgress("")
    }
  }

  return (
    <div className="flex items-start gap-2">
      <Button variant="outline" size="lg" onClick={() => void run()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SearchCheck className="h-3.5 w-3.5" />}
        {busy ? `Checking ${progress}` : "Find Uniware-only POs"}
      </Button>
      {summary && (
        <div className="min-w-0 max-w-xl text-xs leading-relaxed">
          <div className="text-muted-foreground">{summary.counts}</div>
          {summary.lines.length > 0 && (
            <ul className={summary.failed ? "text-destructive" : "text-muted-foreground"}>
              {summary.lines.map((l) => <li key={l} className="break-words">{l}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
