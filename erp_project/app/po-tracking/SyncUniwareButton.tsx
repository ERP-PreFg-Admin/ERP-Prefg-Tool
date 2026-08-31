"use client"

// One button that refreshes every mirrored PO's Uniware status AND pulls the
// goods receipts booked against the ones that have any.
//
// Both in one press on purpose: the status pass learns inflowReceiptsCount for
// free from the call it already makes, so the receipts cost nothing to find and
// only the POs that have them are walked. Two buttons pressed in the wrong
// order is how "0 rejected" comes to mean "nobody synced".
//
// Deliberately not per row: the status of one PO is worth nothing on its own —
// the desk's question is "which of these has Uniware actually approved", and that
// is a whole-list answer. One button also means one request, so the tenant sees
// one authenticated burst instead of a click per row.
//
// The result is a count, not a list. The statuses themselves land in the table
// the caller refreshes through `onDone`; repeating them here would be the same
// information twice.

import { useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { apiErrorMessage } from "@/lib/api-error-message"
import { summariseSync, type SyncResult, type SyncSummary } from "./sync-summary"

export default function SyncUniwareButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy]       = useState(false)
  const [summary, setSummary] = useState<SyncSummary | null>(null)

  async function sync() {
    setBusy(true)
    setSummary(null)
    try {
      const res  = await fetch("/api/v1/purchase-orders/uniware-status", { method: "POST" })
      const data = await res.json().catch(() => ({}))
      // apiErrorMessage rather than `data.error`: withGateway puts the useful
      // half in `details`, and reading only `error` threw it away.
      if (!res.ok) throw new Error(apiErrorMessage(data, "Couldn't reach Uniware."))
      setSummary(summariseSync(data as SyncResult))
      onDone?.()
    } catch (e: unknown) {
      setSummary({
        counts: "Sync failed",
        reasons: [e instanceof Error ? e.message : "Couldn't reach Uniware."],
        failed: true,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-2">
      <Button variant="outline" size="lg" onClick={() => void sync()} disabled={busy}>
        {busy
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <RefreshCw className="h-3.5 w-3.5" />}
        {busy ? "Syncing…" : "Sync Uniware"}
      </Button>
      {/* Inline rather than a toast: the run takes seconds and the reader is
          already looking at this row of the toolbar.

          Counts and reasons are separate lines because they are separate
          questions — "did it work" reads at a glance, "why not" is for the
          person who then has to do something about it. The counts stay muted
          even on failure: "0 of 5 synced" is a fact, not an error. */}
      {summary && (
        <div className="min-w-0 max-w-md text-xs leading-relaxed">
          <div className="text-muted-foreground">{summary.counts}</div>
          {summary.reasons.length > 0 && (
            <ul className={summary.failed ? "text-destructive" : "text-muted-foreground"}>
              {summary.reasons.map((r) => (
                <li key={r} className="break-words">{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
