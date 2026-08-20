"use client"

/**
 * Pull the MFG × facility SKU mapping from Unicommerce — no file, no upload.
 *
 * ── Why the browser drives the loop ──────────────────────────────────────────
 * Unicommerce has no endpoint that returns a vendor's catalogue. Each facility's
 * report is an asynchronous EXPORT JOB (create, poll, download), and there are 18.
 * One request gets 300s — enough for one facility, nowhere near eighteen — and this
 * repo has no queue or worker to hand the sequence to. So this component is the
 * scheduler: it calls the per-facility route once each, in order, and streams the
 * steps back.
 *
 * ── Why localStorage ────────────────────────────────────────────────────────
 * A full run is minutes long, and losing it to a stray refresh would mean redoing
 * every completed facility. Progress is recorded per facility as it lands, so
 * reopening resumes at the first one not yet done. The record is CLEARED the moment
 * a run completes — it exists to survive an interruption, not to accumulate.
 *
 * Nothing else is stored: the CSV lives briefly in server memory inside
 * lib/mfg-facility-sync.ts and is never written down, so there is no file to delete
 * afterwards.
 */

import { useCallback, useState } from "react"
import { RefreshCw, Check, AlertTriangle, Ban } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"

/** Bumped if the shape below changes, so an old record is ignored rather than
 *  misread. */
const STORE_KEY = "mfg-facility-sync/v1"

type FacilityState = {
  status: "pending" | "running" | "done" | "failed" | "skipped"
  written?: number
  /** Rows in Uniware's export before matching. Read WITH `written`: a large read
   *  and a zero written is a matching problem, whereas read 0 is a facility one. */
  read?: number
  /** The dominant reason rows were skipped, when any were. */
  topSkip?: string
  error?: string
  /** A bad facility code will fail the same way forever — don't offer a retry. */
  fatal?: boolean
  /** What the server is doing right now, for the live row. */
  note?: string
}

type Run = { startedAt: string; byFacility: Record<string, FacilityState> }

function load(): Run | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Run) : null
  } catch {
    // A corrupt or quota-exceeded entry must not break the button.
    return null
  }
}

function save(run: Run | null) {
  try {
    if (run) localStorage.setItem(STORE_KEY, JSON.stringify(run))
    else localStorage.removeItem(STORE_KEY)
  } catch {
    // Progress is a convenience, not the record — the database already has the
    // rows. Failing to persist must not stop the run.
  }
}

const ICON: Record<FacilityState["status"], typeof Check> = {
  pending: RefreshCw, running: RefreshCw, done: Check, failed: AlertTriangle, skipped: Ban,
}

export function SyncFacilityMapDialog({
  facilities,
  onSynced,
}: {
  /** Facility codes to sync, in the matrix's own column order. */
  facilities: { code: string; label: string }[]
  onSynced: () => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<Run | null>(null)

  /**
   * Open, reading any interrupted run back from localStorage.
   *
   * Done here rather than in an effect for two reasons: localStorage does not exist
   * during the server render, so it cannot seed a useState initialiser without a
   * hydration mismatch; and a click handler is not an effect, so it does not trigger
   * the cascading render that react-hooks/set-state-in-effect exists to prevent.
   */
  function openDialog() {
    setRun(load())
    setOpen(true)
  }

  const update = useCallback((code: string, patch: Partial<FacilityState>) => {
    setRun((current) => {
      const base: Run = current ?? { startedAt: new Date().toISOString(), byFacility: {} }
      // The fallback is spread, not written as a literal key beside the spread:
      // `{ status: "pending", ...existing }` declares status twice and the literal
      // is the one discarded, so a missing entry would come out undefined.
      const existing: FacilityState = base.byFacility[code] ?? { status: "pending" }
      const next: Run = {
        ...base,
        byFacility: { ...base.byFacility, [code]: { ...existing, ...patch } },
      }
      save(next)
      return next
    })
  }, [])

  /** Stream one facility, reporting each step. Resolves with what happened. */
  async function syncOne(code: string): Promise<{
    ok: boolean; written: number; read: number
    topSkip?: string; fatal?: boolean; error?: string
  }> {
    update(code, { status: "running", note: "queueing export", error: undefined })

    const res = await fetch("/api/v1/manufacturing/facility-map/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facility_code: code }),
    })
    if (!res.ok || !res.body) {
      // A real status code here means auth or validation — it happens before
      // streaming starts, so the body is a normal error envelope.
      const msg = await res.text().catch(() => "")
      throw new Error(msg.slice(0, 200) || `Request failed (HTTP ${res.status})`)
    }

    // NDJSON: split on newlines and carry the partial line forward — a chunk
    // boundary lands mid-object often enough that not doing this looks random.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let outcome: {
      ok: boolean; written: number; read: number
      topSkip?: string; fatal?: boolean; error?: string
    } | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.done) {
          const r = msg.result ?? {}
          // The biggest skip reason is the diagnosis when read > 0 but written = 0 —
          // the case that previously just said "0 mapped" and explained nothing.
          const skips = Object.entries((r.skipped ?? {}) as Record<string, number>)
            .sort((a, b) => b[1] - a[1])
          outcome = {
            ok: !!r.ok, written: r.written ?? 0, read: r.read ?? 0,
            topSkip: skips.length ? `${skips[0][0]} (${skips[0][1].toLocaleString("en-IN")})` : undefined,
            fatal: r.fatal, error: r.error,
          }
        } else if (msg.step === "poll" && msg.status === "tick") {
          update(code, { note: `waiting for Uniware (check ${msg.attempt})` })
        } else if (msg.step === "download") {
          update(code, { note: msg.status === "ok" ? `read ${msg.rows} rows` : "downloading" })
        } else if (msg.step === "apply") {
          update(code, { note: msg.status === "ok" ? `wrote ${msg.written}` : "matching to our SKUs" })
        } else if (msg.step === "job" && msg.status === "ok") {
          update(code, { note: "export queued" })
        }
      }
    }
    if (!outcome) throw new Error("The sync ended without reporting a result")
    return outcome
  }

  async function syncAll(only?: string[]) {
    setBusy(true)
    const targets = (only ?? facilities.map((f) => f.code)).filter(Boolean)
    let written = 0
    let failed = 0

    for (const code of targets) {
      try {
        const r = await syncOne(code)
        written += r.written
        if (r.ok) {
          update(code, {
            status: "done", written: r.written, read: r.read,
            topSkip: r.topSkip, note: undefined,
          })
        } else {
          failed++
          update(code, {
            status: r.fatal ? "skipped" : "failed",
            fatal: r.fatal, error: r.error, note: undefined,
          })
        }
      } catch (err) {
        failed++
        update(code, {
          status: "failed",
          error: err instanceof Error ? err.message : "Request failed",
          note: undefined,
        })
      }
    }

    setBusy(false)
    onSynced()
    toast({
      title: failed === 0 ? "Sync complete" : `Synced with ${failed} problem${failed === 1 ? "" : "s"}`,
      description: `${written.toLocaleString("en-IN")} mappings written from ${targets.length} ${targets.length === 1 ? "facility" : "facilities"}.`,
      variant: failed === 0 ? "success" : "info",
    })

    // A clean run has nothing left to resume, so the record goes. A run with
    // problems keeps it, which is what makes "Retry failed" possible.
    if (failed === 0) { save(null); setRun(null) }
  }

  const states = run?.byFacility ?? {}
  const doneCount = facilities.filter((f) => states[f.code]?.status === "done").length
  const retryable = facilities
    .filter((f) => states[f.code]?.status === "failed" && !states[f.code]?.fatal)
    .map((f) => f.code)
  const unfinished = facilities.filter((f) => {
    const s = states[f.code]?.status
    return s !== "done" && s !== "skipped"
  }).map((f) => f.code)

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        Sync from Uniware
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sync mapping from Uniware</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">
            Runs Unicommerce&apos;s Vendor Item Master export for each facility in turn, then
            matches what comes back against our manufacturers and SKUs. Nothing is downloaded to
            your machine and no copy is kept.
          </p>

          <Callout variant="info">
            Only SKUs already in the SKU master are mapped, and a vendor code no manufacturer is
            mapped to is <strong>skipped rather than guessed</strong> — that keeps an unrecognised
            code visible as something to map instead of attributing stock to the wrong company.
          </Callout>

          {run && doneCount > 0 && !busy && unfinished.length > 0 && (
            <Callout variant="warning">
              A run from {new Date(run.startedAt).toLocaleString()} stopped partway.
              {" "}{doneCount} of {facilities.length} facilities are done — continuing will pick up
              from the rest.
            </Callout>
          )}

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {facilities.map((f) => {
              const s = states[f.code] ?? { status: "pending" as const }
              const Icon = ICON[s.status]
              return (
                <div
                  key={f.code}
                  className="flex items-center gap-2.5 rounded border border-border/60 px-2.5 py-1.5 text-xs"
                >
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      s.status === "running" && "animate-spin text-primary",
                      s.status === "done" && "text-emerald-600 dark:text-emerald-400",
                      s.status === "failed" && "text-destructive",
                      s.status === "skipped" && "text-muted-foreground",
                      s.status === "pending" && "text-muted-foreground/40",
                    )}
                  />
                  <span className="font-mono uppercase tracking-wide">{f.code}</span>
                  <span className="truncate text-muted-foreground">{f.label}</span>
                  <span className="ml-auto shrink-0 text-right text-muted-foreground">
                    {s.note ? (
                      s.note
                    ) : s.status === "done" ? (
                      <span
                        // The skip reason is the whole diagnosis when nothing mapped,
                        // so it is on the row rather than hidden in a log.
                        title={s.topSkip ? `Skipped: ${s.topSkip}` : undefined}
                        className={cn(s.written === 0 && "text-amber-700 dark:text-amber-400")}
                      >
                        {(s.read ?? 0).toLocaleString("en-IN")} read →{" "}
                        {(s.written ?? 0).toLocaleString("en-IN")} mapped
                        {s.written === 0 && s.topSkip && (
                          <span className="ml-1.5 opacity-80">· {s.topSkip}</span>
                        )}
                      </span>
                    ) : s.error ? (
                      <span className="text-destructive" title={s.error}>{s.error.slice(0, 60)}</span>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span className="mr-auto self-center text-xs text-muted-foreground">
              {busy
                ? `${doneCount} of ${facilities.length} done`
                : run
                  ? `${doneCount} of ${facilities.length} synced`
                  : `${facilities.length} facilities`}
            </span>
            {run && !busy && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { save(null); setRun(null) }}
              >
                Clear progress
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </Button>
            {retryable.length > 0 && !busy && (
              <Button variant="outline" size="sm" onClick={() => syncAll(retryable)}>
                Retry {retryable.length} failed
              </Button>
            )}
            <Button
              size="sm"
              disabled={busy || facilities.length === 0}
              onClick={() => syncAll(doneCount > 0 && unfinished.length > 0 ? unfinished : undefined)}
            >
              {busy
                ? "Syncing…"
                : doneCount > 0 && unfinished.length > 0
                  ? `Continue (${unfinished.length} left)`
                  : "Sync all facilities"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
