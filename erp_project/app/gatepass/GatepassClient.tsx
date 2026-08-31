"use client"

// The GatePass screen's one moving part: pick a day and some facilities, then
// pull each facility's Sale Orders export and count orders per package type.
//
// ── Why the loop lives in the browser ───────────────────────────────────────
// A Unicommerce export is an asynchronous job PER FACILITY (create, poll,
// download) taking tens of seconds. Twenty of them cannot fit in one 300s
// request, and this repo has no queue or worker — so the client is the
// scheduler, calling /api/v1/gatepass/summary once per facility, SEQUENTIALLY.
// Never in parallel: twenty concurrent export jobs is how an integration gets
// throttled, and the tenant is shared with the rest of the business.
//
// The consequence is honest rather than hidden: an all-facility run takes
// minutes, so it shows per-facility progress and can be stopped. Results appear
// facility by facility as they land, so the first answer is useful long before
// the last one arrives.

import { useRef, useState } from "react"
import { Loader2, Play, Download, X, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DateRangePicker } from "@/components/ui/date-picker"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { apiErrorMessage } from "@/lib/api-error-message"
import { cn } from "@/lib/utils"
import { combineDates, type PackageTypeRow } from "@/lib/gatepass/summary"
import type { GatepassPlan } from "@/lib/gatepass/plan"
import PlanGatepassDialog from "./PlanGatepassDialog"

/**
 * A facility is tracked only while it still has something to say. On success it
 * is REMOVED — its answer is the rows now in the table, and a twenty-facility
 * run whose progress list outlives its own results is just clutter.
 *
 * "empty" is the one success that stays: a facility that ran and found no orders
 * has no rows in the table, so dropping it too would make "nothing to ship" and
 * "never selected" look identical.
 */
type Progress = { status: "pending" | "running" | "empty" | "failed"; note?: string; error?: string }

const n = (v: number) => v.toLocaleString("en-IN")

export default function GatepassClient({
  facilities, defaultFacility, defaultDay, today, maxRangeDays,
}: {
  facilities: string[]
  defaultFacility: string
  defaultDay: string
  today: string
  maxRangeDays: number
}) {
  const [from, setFrom] = useState(defaultDay)
  const [to, setTo] = useState(defaultDay)
  const [selected, setSelected] = useState<Set<string>>(new Set([defaultFacility]))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [rows, setRows] = useState<PackageTypeRow[]>([])
  const [plans, setPlans] = useState<GatepassPlan[]>([])
  const [planOpen, setPlanOpen] = useState(false)
  const [ranFor, setRanFor] = useState<{ from: string; to: string } | null>(null)
  // Facilities that finished cleanly, counted rather than listed — the panel
  // empties out, and this is what stops that reading as work vanishing.
  const [doneCount, setDoneCount] = useState(0)
  // How the SAME fetched rows are read. Purely a view: switching never
  // re-runs an export, which is why it stays enabled after a run finishes.
  const [view, setView] = useState<"daily" | "combined">("daily")
  const abort = useRef<AbortController | null>(null)

  const toggle = (code: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (!next.delete(code)) next.add(code)
      return next
    })

  // Partial: a poll tick updates only the note, and re-stating the status each
  // time is how one gets flipped back to "running" after it has already failed.
  const mark = (code: string, patch: Partial<Progress>) =>
    setProgress((p) => ({ ...p, [code]: { ...(p[code] ?? { status: "pending" }), ...patch } }))

  /** Finished with rows in the table — drop the progress entry entirely. */
  const clear = (code: string) => {
    setProgress((p) => {
      const next = { ...p }
      delete next[code]
      return next
    })
    setDoneCount((c) => c + 1)
  }

  /** Stream one facility, appending its rows the moment they land. */
  async function runOne(code: string, signal: AbortSignal) {
    mark(code, { status: "running", note: "queueing export", error: undefined })

    const res = await fetch("/api/v1/gatepass/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facility_code: code, from, to }),
      signal,
    })
    if (!res.ok || !res.body) {
      // A real status code here is auth or validation — it happens before
      // streaming starts, so the body is a normal error envelope.
      const data = await res.json().catch(() => ({}))
      mark(code, { status: "failed", note: undefined, error: apiErrorMessage(data, `Request failed (HTTP ${res.status})`) })
      return
    }

    // NDJSON: split on newlines and carry the partial line forward — a chunk
    // boundary lands mid-object often enough that not doing this looks random.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

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
          if (r.ok) {
            setRows((current) => [...current, ...(r.summary as PackageTypeRow[])])
            if (r.plan) setPlans((current) => [...current, r.plan as GatepassPlan])
            if (r.summary.length) {
              // Its answer is in the table now — the progress row has nothing
              // left to tell anyone.
              clear(code)
            } else {
              mark(code, { status: "empty", error: undefined, note: "ran · no orders in this window" })
            }
          } else {
            mark(code, { status: "failed", note: undefined, error: r.error || "Failed" })
          }
        } else if (msg.step === "poll" && msg.status === "tick") {
          mark(code, { note: `waiting for Uniware (check ${msg.attempt})` })
        } else if (msg.step === "download" && msg.status === "start") {
          mark(code, { note: "downloading export" })
        }
      }
    }
  }

  async function run() {
    const codes = [...selected]
    if (codes.length === 0 || running) return

    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setRows([])
    setPlans([])
    setDoneCount(0)
    setRanFor({ from, to })
    setProgress(Object.fromEntries(codes.map((c) => [c, { status: "pending" as const }])))

    try {
      for (const code of codes) {
        if (controller.signal.aborted) break
        try {
          await runOne(code, controller.signal)
        } catch (e: unknown) {
          if (controller.signal.aborted) break
          // One facility failing must not stop the other nineteen — the whole
          // reason the loop catches per iteration rather than around it.
          mark(code, { status: "failed", note: undefined, error: e instanceof Error ? e.message : String(e) })
        }
      }
    } finally {
      setRunning(false)
      abort.current = null
    }
  }

  function stop() {
    abort.current?.abort()
    setRunning(false)
    setProgress((p) =>
      Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, v.status === "pending" || v.status === "running"
          ? { ...v, status: "failed" as const, note: undefined, error: "stopped" } : v])
      )
    )
  }

  function downloadCsv() {
    // Follows the view on screen: exporting the daily split while looking at
    // the combined table (or the reverse) is the kind of mismatch nobody checks.
    const header = daily
      ? ["facility", "invoice_date", "package_type", "boxes"]
      : ["facility", "from", "to", "package_type", "boxes"]
    const body = daily
      ? dailyRows.map((r) => [r.facility, r.date, r.package_type, r.orders])
      : combined.map((r) => [r.facility, windowFrom, windowTo, r.package_type, r.orders])
    // Quoted because a package type is free-text and may contain a comma; "" is
    // how a literal quote is escaped in CSV.
    const csv = [header, ...body]
      .map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `gatepass_summary_${windowLabel.replace(/\s*→\s*/, "_to_")}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const daily = view === "daily"
  // Facility first so one site stays together, then date ascending so a range
  // reads as a diary, then biggest first — the order the desk works down.
  const dailyRows = [...rows].sort(
    (a, b) => a.facility.localeCompare(b.facility)
      || a.date.localeCompare(b.date)
      || b.orders - a.orders
      || a.package_type.localeCompare(b.package_type)
  )
  // The whole window as one row per package type. Folded from rows already
  // fetched — switching view never costs another export.
  const combined = combineDates(rows)
  const shownCount = daily ? dailyRows.length : combined.length
  const totalOrders = rows.reduce((sum, r) => sum + r.orders, 0)
  const tracked = Object.entries(progress)
  const failures = tracked.filter(([, p]) => p.status === "failed").length
  const empties = tracked.filter(([, p]) => p.status === "empty").length

  const label = (a: string, b: string) => (a === b ? a : `${a} → ${b}`)
  const windowFrom = ranFor?.from ?? from
  const windowTo = ranFor?.to ?? to
  const windowLabel = label(windowFrom, windowTo)
  // Inclusive, so a same-day range is 1.
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  const rangeInvalid = !(spanDays >= 1 && spanDays <= maxRangeDays)

  return (
    <div className="space-y-5">
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Invoice date (IST){spanDays > 1 && ` · ${spanDays} days`}
          </label>
          {/* max=today: an export for tomorrow is always empty, and offering it
              only produces a confusing blank result. The whole range becomes ONE
              export job per facility — a wider window is a bigger CSV, not more jobs. */}
          <DateRangePicker
            from={from} to={to}
            onChange={(f, t) => { setFrom(f); setTo(t) }}
            max={today} disabled={running}
          />
        </div>


        <div className="flex-1 min-w-[280px] space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              Facilities · {selected.size} of {facilities.length}
            </label>
            <div className="flex gap-3 text-xs">
              <button
                type="button" disabled={running}
                className="text-primary hover:underline disabled:opacity-50"
                onClick={() => setSelected(new Set(facilities))}
              >All</button>
              <button
                type="button" disabled={running}
                className="text-primary hover:underline disabled:opacity-50"
                onClick={() => setSelected(new Set())}
              >None</button>
            </div>
          </div>
          {/* One control for "one facility", "some" and "all" — a single select
              plus a separate All toggle would be two widgets and a rule about
              which wins. */}
          <div className="flex flex-wrap gap-1.5 rounded-md border p-2 max-h-32 overflow-y-auto">
            {facilities.map((code) => {
              const on = selected.has(code)
              return (
                <button
                  key={code} type="button" disabled={running} onClick={() => toggle(code)}
                  className={cn(
                    "rounded px-2 py-1 text-xs border transition-colors disabled:opacity-60",
                    on ? "bg-primary text-primary-foreground border-primary"
                       : "bg-background hover:bg-muted border-input"
                  )}
                >{code}</button>
              )
            })}
          </div>
        </div>

        <div className="flex gap-2">
          {running ? (
            <Button variant="outline" onClick={stop}>
              <X className="h-3.5 w-3.5" /> Stop
            </Button>
          ) : (
            <Button onClick={() => void run()} disabled={selected.size === 0 || rangeInvalid}>
              <Play className="h-3.5 w-3.5" /> Run
            </Button>
          )}
          <Button variant="outline" onClick={() => setPlanOpen(true)} disabled={plans.length === 0}>
            <FileText className="h-3.5 w-3.5" /> Plan gatepasses
          </Button>
          <Button variant="outline" onClick={downloadCsv} disabled={rows.length === 0}>
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
        </div>
      </div>

      {rangeInvalid && (
        <p className="text-xs text-destructive">
          {spanDays < 1
            ? "The range ends before it starts."
            : `${spanDays} days is more than the ${maxRangeDays}-day maximum for one run.`}
        </p>
      )}

      {/* An all-facility run is minutes of someone else's system, so say so
          before it is clicked rather than after. The job count follows the
          FACILITY count — a wider date range is one bigger export, not more of them. */}
      {selected.size > 4 && !running && !rangeInvalid && (
        <p className="text-xs text-muted-foreground">
          {selected.size} facilities means {selected.size} export jobs, run one after another —
          expect a few minutes. Results appear as each facility finishes.
          {spanDays > 31 && ` A ${spanDays}-day window also makes each export a large one.`}
        </p>
      )}

      {/* ── Per-facility progress ─────────────────────────────────────────
          Only what still has something to say: in flight, empty, or failed.
          A facility whose rows landed in the table below has already answered,
          so its row is removed rather than left showing a stale "done". */}
      {tracked.length > 0 && (
        <div className="rounded-md border divide-y text-sm">
          {tracked.map(([code, p]) => (
            <div key={code} className="flex items-center gap-3 px-3 py-1.5">
              <span className="w-40 shrink-0 font-medium">{code}</span>
              {p.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <span className={cn(
                "text-xs truncate",
                p.status === "failed" ? "text-destructive" : "text-muted-foreground"
              )}>
                {p.error ?? p.note ?? (p.status === "pending" ? "queued" : "")}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* The panel emptying out must not read as work disappearing. */}
      {(doneCount > 0 || empties > 0 || failures > 0) && (
        <p className="text-xs text-muted-foreground">
          {n(doneCount)} facilit{doneCount === 1 ? "y" : "ies"} returned orders
          {empties > 0 && ` · ${n(empties)} empty`}
          {failures > 0 && <span className="text-destructive"> · {n(failures)} failed</span>}
        </p>
      )}

      {/* Reads as a caption on the table below, which is what it controls.
          Always visible — gating it on "a run has finished" is what made it look
          absent. Enabled mid-run too: it re-reads rows already fetched and never
          triggers another export. */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">View</span>
        <SegmentedToggle
          size="xs"
          active={view}
          onSelect={setView}
          options={[
            { key: "daily", label: "Day by day" },
            { key: "combined", label: "Aggregated" },
          ]}
        />
      </div>

      {/* ── The answer ───────────────────────────────────────────────────── */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">Facility</TableHead>
              {/* Dropped rather than filled with the same range on every row —
                  a column of identical values is noise. The window is in the
                  footer and in the picker. */}
              {daily && <TableHead className="w-32">Invoice date</TableHead>}
              <TableHead>Package type</TableHead>
              <TableHead className="w-28 text-right">Boxes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownCount === 0 ? (
              <TableEmpty colSpan={daily ? 4 : 3}>
                {running ? "Pulling exports…" : "Pick dates and one or more facilities, then Run."}
              </TableEmpty>
            ) : daily ? (
              dailyRows.map((r) => (
                <TableRow key={`${r.facility}:${r.date}:${r.package_type}`}>
                  <TableCell className="text-muted-foreground">{r.facility}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{r.date}</TableCell>
                  <TableCell className="font-medium">{r.package_type}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(r.orders)}</TableCell>
                </TableRow>
              ))
            ) : (
              combined.map((r) => (
                <TableRow key={`${r.facility}:${r.package_type}`}>
                  <TableCell className="text-muted-foreground">{r.facility}</TableCell>
                  <TableCell className="font-medium">{r.package_type}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(r.orders)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {shownCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>
            {n(shownCount)} rows · {n(totalOrders)} boxes · {windowLabel}
            {!daily && spanDays > 1 && ` · ${spanDays} days combined`}
          </span>
        </div>
      )}

      <PlanGatepassDialog
        open={planOpen} onOpenChange={setPlanOpen} plans={plans}
        from={ranFor?.from ?? from} to={ranFor?.to ?? to}
      />
    </div>
  )
}
