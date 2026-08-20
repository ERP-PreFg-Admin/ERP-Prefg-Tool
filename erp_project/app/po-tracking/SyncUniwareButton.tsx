"use client"

// One button that refreshes every mirrored PO's Uniware status.
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

type SyncResult = {
  total: number
  synced: number
  failed: number
  failures?: { code: string; error: string }[]
  truncated?: boolean
  limit?: number
}

/** One line for the toast — says what the run did, including what it skipped. */
function summarise(r: SyncResult): string {
  if (r.total === 0) return "No mirrored POs to sync yet."
  const parts = [`${r.synced} of ${r.total} synced`]
  if (r.failed) {
    parts.push(`${r.failed} failed`)
    // The first one's reason, since "3 failed" alone leaves nothing to act on.
    if (r.failures?.[0]) parts.push(`first: ${r.failures[0].code} — ${r.failures[0].error}`)
  }
  // Never let a cap pass unmentioned: "40 of 40 synced" would otherwise read as
  // the whole list when it was the newest 40 of 300.
  if (r.truncated) parts.push(`only the newest ${r.limit} were checked`)
  return parts.join(" · ")
}

export default function SyncUniwareButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy]       = useState(false)
  const [result, setResult]   = useState("")
  const [failed, setFailed]   = useState(false)

  async function sync() {
    setBusy(true)
    setResult("")
    setFailed(false)
    try {
      const res  = await fetch("/api/v1/purchase-orders/uniware-status", { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Couldn't reach Uniware.")
      setResult(summarise(data as SyncResult))
      // Partial failure still refreshes: the ones that worked are worth showing.
      setFailed(Number(data.failed) > 0)
      onDone?.()
    } catch (e: unknown) {
      setResult(e instanceof Error ? e.message : "Couldn't reach Uniware.")
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="lg" onClick={() => void sync()} disabled={busy}>
        {busy
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <RefreshCw className="h-3.5 w-3.5" />}
        {busy ? "Syncing…" : "Sync Uniware"}
      </Button>
      {/* Inline rather than a toast: the run takes seconds and the reader is
          already looking at this row of the toolbar. */}
      {result && (
        <span className={failed ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {result}
        </span>
      )}
    </div>
  )
}
