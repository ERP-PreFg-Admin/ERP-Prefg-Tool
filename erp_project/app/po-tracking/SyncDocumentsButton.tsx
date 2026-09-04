"use client"

// Pulls documents attached on each mirrored Uniware PO into our S3 and pushes our
// supplier-invoice PDF up — the reconciling half of the Uniware document feature.
// Sibling of SyncUniwareButton; same shape, different endpoint and summary.
//
// It does both directions because they are the same gap seen from two sides: a
// push that was skipped (session was stale at invoice time) and a signed copy not
// yet pulled are both "this invoice and its Uniware PO are out of step", and one
// press settles both.

import { useState } from "react"
import { Loader2, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { apiErrorMessage } from "@/lib/api-error-message"
import { summariseDocSync, type DocSyncResult, type SyncSummary } from "./sync-summary"

export default function SyncDocumentsButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy]       = useState(false)
  const [summary, setSummary] = useState<SyncSummary | null>(null)

  async function sync() {
    setBusy(true)
    setSummary(null)
    try {
      const res  = await fetch("/api/v1/purchase-orders/uniware-documents", { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(apiErrorMessage(data, "Couldn't reach Uniware."))
      setSummary(summariseDocSync(data as DocSyncResult))
      onDone?.()
    } catch (e: unknown) {
      setSummary({
        counts: "Document sync failed",
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
          : <FileText className="h-3.5 w-3.5" />}
        {busy ? "Syncing…" : "Sync Documents"}
      </Button>
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
