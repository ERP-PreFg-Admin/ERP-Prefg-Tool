"use client"

// Add Invoice → inward POs.
//
// Three phases in one dialog: pick a PDF, parse it with Nanonets, then review
// the parsed fields side by side with the original before anything is written.
//
// Nothing is persisted server-side until the user clicks "Create Inward POs" —
// the PDF is posted straight to the parser and previewed from a local blob URL,
// and the S3 upload happens as the first step of submit. Abandoning a review
// leaves nothing on the server.
//
// It does leave a local checkpoint: the review (PDF included) is mirrored to
// IndexedDB so a closed tab can be resumed instead of re-parsed. See
// invoice-draft.ts, which also explains why that isn't localStorage.
//
// This file is the orchestration only. The form model and its rules live in
// invoice-form.ts, the requests in invoice-api.ts, and the two halves of the
// review pane in InvoiceFields.tsx / InvoiceLineItems.tsx.

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, FileUp, History, Loader2, RotateCw } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { OpenPoOption } from "@/types/invoice"
import type { MfgOption, SkuOption, WarehouseOption } from "../po-procurement/po-types"
import {
  EMPTY_FORM, MAX_BYTES, allocateFifo, collectProblems, emptyRow, formFromParsed,
  matchSummary, rowsFromParsed, sumLineItems, toInwardPayload,
  type InvoiceForm, type Row, type Shortage,
} from "./invoice-form"
import { commitInvoice, fetchOpenPos, parseInvoiceFile, type InwardStep } from "./invoice-api"
import { clearDraft, loadDraft, saveDraft, savedAgo, type InvoiceDraft } from "./invoice-draft"
import { InvoiceFields } from "./InvoiceFields"
import { InvoiceLineItems } from "./InvoiceLineItems"
import { useSplitPane } from "./useSplitPane"

type Phase = "pick" | "parsing" | "review"

/** Shown on the button while a step runs, and as that step's toast title. */
const STEP_LABEL: Record<InwardStep, string> = {
  s3:      "Invoice stored",
  po:      "Inward POs created",
  uniware: "Sent to Uniware",
  email:   "Warehouse notified",
}

const STEP_PROGRESS: Record<InwardStep, string> = {
  s3:      "Storing invoice…",
  po:      "Creating inward POs…",
  uniware: "Sending to Uniware…",
  email:   "Notifying warehouse…",
}

export default function AddInvoiceDialog({
  open, onClose, skuOptions, mfgOptions, warehouseOptions, onCreated,
}: {
  open: boolean
  onClose: () => void
  skuOptions: SkuOption[]
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  onCreated: () => void
}) {
  const { toast } = useToast()

  const [phase, setPhase]   = useState<Phase>("pick")
  const [error, setError]   = useState("")
  const [elapsed, setElapsed] = useState(0)
  /** "" when idle; otherwise which step of submit is running, for the button. */
  /** "" when idle; otherwise the step currently running, for the button label. */
  const [submitStep, setSubmitStep] = useState<"" | InwardStep>("")

  /** Held in memory for the whole review — it's the only copy until submit. */
  const [file, setFile]     = useState<File | null>(null)
  const [pdfUrl, setPdfUrl] = useState("")

  const [form, setForm]   = useState<InvoiceForm>(EMPTY_FORM)
  const [rows, setRows]   = useState<Row[]>([])
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [openPos, setOpenPos] = useState<OpenPoOption[]>([])
  /** SKUs the open POs couldn't cover, from the last FIFO match. */
  const [shortages, setShortages] = useState<Shortage[]>([])

  /** A checkpointed review found on open, offered for resume. */
  const [draft, setDraft] = useState<InvoiceDraft | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhrRef       = useRef<XMLHttpRequest | null>(null)
  /** Latest rows, readable from applyFifo without putting `rows` in the
   *  open-PO effect's deps — which would re-fetch on every allocation. */
  const rowsRef      = useRef<Row[]>([])
  /** Set once the invoice is filed, so closing doesn't resurrect its draft. */
  const committedRef = useRef(false)
  const split        = useSplitPane(50)

  const submitting = submitStep !== ""
  const isReview   = phase === "review"
  const busy       = phase === "parsing" || submitting

  function setField<K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function reset() {
    setPhase("pick"); setError(""); setElapsed(0); setSubmitStep("")
    // Blob URLs are held by the document until explicitly revoked; without this
    // every reviewed invoice leaks its full size for the life of the tab.
    setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return "" })
    setFile(null)
    setForm(EMPTY_FORM); setRows([]); setExtra({}); setOpenPos([]); setShortages([])
    committedRef.current = false
    split.reset()
  }

  /** Radix keeps this component mounted between openings, so the form has to be
   *  cleared explicitly or the next invoice opens showing the last one's data.
   *  Done on the way out rather than in an open-effect — resetting in an effect
   *  renders the stale form for a frame first. */
  function closeAndReset() {
    xhrRef.current?.abort()
    // The autosave is debounced, so an edit made in the last 800ms hasn't been
    // written yet. Flush it — closing is exactly when it matters most.
    //
    // Unless the invoice was just committed. A ref, not the `submitting` state:
    // handleSubmit closes over the render in which it was created, where
    // submitStep is still "", so reading state here would always say "not
    // submitting" and flush the draft straight back after clearDraft() — the
    // next Add Invoice would then offer to resume an invoice already filed.
    if (!committedRef.current && phase === "review" && file) {
      void saveDraft({ fileName: file.name, file, form, rows, extra })
    }
    reset()
    onClose()
  }

  /** Pick up a checkpointed review: no re-upload, no second 60s parse. */
  function resumeDraft(d: InvoiceDraft) {
    setError("")
    setFile(d.file)
    setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(d.file) })
    setForm(d.form)
    setRows(d.rows)
    setExtra(d.extra)
    setDraft(null)
    setPhase("review")
  }

  function discardDraft() {
    setDraft(null)
    void clearDraft()
  }

  // Elapsed counter — a minute of "Parsing…" with no moving number reads as a hang.
  useEffect(() => {
    if (phase !== "parsing") return
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  // Abort an in-flight upload if the dialog is dismissed mid-transfer.
  useEffect(() => () => xhrRef.current?.abort(), [])

  // Look for an unfinished review each time the dialog opens on the pick screen.
  // Async, so this never sets state synchronously during the effect.
  useEffect(() => {
    if (!open || phase !== "pick") return
    let cancelled = false
    void loadDraft().then((d) => { if (!cancelled) setDraft(d) })
    return () => { cancelled = true }
  }, [open, phase])

  // Checkpoint the review as it's edited. Debounced because this fires on every
  // keystroke, and each save writes the whole PDF back to IndexedDB.
  useEffect(() => {
    if (phase !== "review" || !file || submitting) return
    const t = setTimeout(() => {
      void saveDraft({ fileName: file.name, file, form, rows, extra })
    }, 800)
    return () => clearTimeout(t)
  }, [phase, file, form, rows, extra, submitting])

  // rows, mirrored for applyFifo. An effect rather than assigning during render,
  // so a concurrent re-render can't publish a value the commit then discards.
  useEffect(() => { rowsRef.current = rows }, [rows])

  /** Allocate every line against `pos`, oldest PO raise date first. Splits a
   *  line across POs when one can't cover it, and re-running is idempotent —
   *  allocateFifo merges previous splits back before it starts. */
  function applyFifo(pos: OpenPoOption[]) {
    const result = allocateFifo(rowsRef.current, pos)
    rowsRef.current = result.rows
    setRows(result.rows)
    setShortages(result.shortages)
  }

  // Reference-PO options follow the manufacturer. Refetched rather than filtered
  // client-side because the full open-PO set across all manufacturers is large.
  // Only the fetch lives here — clearing happens in changeMfg, at the event, so
  // this never calls setState synchronously on the way in.
  //
  // The FIFO match runs off the back of it: arriving POs are the moment there is
  // something to match against, and it's the same moment changeMfg has just
  // invalidated every reference. Not re-run on every row edit — that would
  // re-split rows out from under someone typing a quantity; the "Re-match POs"
  // button and the blocking problems below cover the edit case instead.
  useEffect(() => {
    if (phase !== "review" || !form.mfgId) return
    let cancelled = false
    void fetchOpenPos(form.mfgId).then((pos) => {
      if (cancelled) return
      setOpenPos(pos)
      applyFifo(pos)
    })
    return () => { cancelled = true }
  }, [form.mfgId, phase])

  /** Switching manufacturer invalidates both the PO list and every reference
   *  already chosen from it — they belonged to the previous manufacturer. */
  function changeMfg(value: string) {
    setField("mfgId", value)
    setOpenPos([])
    setShortages([])
    setRows((prev) => (prev.some((r) => r.reference_po_id)
      ? prev.map((r) => ({ ...r, reference_po_id: "" }))
      : prev))
  }

  // ── Phase 1: accept the file (nothing leaves the browser but the parse) ───
  function handleFile(picked: File | undefined) {
    if (!picked) return
    const isPdf = picked.type === "application/pdf" || picked.name.toLowerCase().endsWith(".pdf")
    if (!isPdf) { setError("Only PDF invoices can be uploaded."); return }
    if (picked.size > MAX_BYTES) { setError("That file is over the 10 MB limit."); return }

    setError("")
    setFile(picked)
    // Preview straight from the local file — no round trip, and no stored object
    // to clean up if the user walks away.
    setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(picked) })
    void runParse(picked)
  }

  // ── Phase 2: parse (retryable — re-posts the file, still nothing stored) ──
  async function runParse(target: File) {
    setPhase("parsing")
    setError("")
    setElapsed(0)
    try {
      const { parsed, detected } = await parseInvoiceFile(target)
      // Every value here is a suggestion; the review step exists to override it.
      const next = formFromParsed(parsed, mfgOptions, warehouseOptions)
      // An exact GSTIN match beats fuzzy-matching the printed seller name, so
      // it wins when detection found one. formFromParsed's matchMfg result
      // stands otherwise — a scanned PDF yields no GSTIN at all.
      if (detected && mfgOptions.some((m) => m.id === detected.mfgId)) {
        next.mfgId = String(detected.mfgId)
      }
      setForm(next)
      setRows(rowsFromParsed(parsed, skuOptions))
      setExtra(parsed.extra ?? {})
      setPhase("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invoice parsing failed.")
    }
  }

  // ── Phase 3: validate + create ────────────────────────────────────────────
  const poById   = useMemo(() => new Map(openPos.map((p) => [String(p.id), p])), [openPos])
  const problems = useMemo(
    () => collectProblems(form, rows, poById, shortages),
    [form, rows, poById, shortages]
  )
  const lineSum  = useMemo(() => sumLineItems(rows), [rows])
  const matched  = useMemo(() => matchSummary(form, rows, shortages), [form, rows, shortages])
  const receiveCount = useMemo(() => rows.filter((r) => r.reference_po_id).length, [rows])

  async function handleSubmit() {
    if (problems.length > 0 || !file) return
    setError("")
    setSubmitStep("s3")
    try {
      // One request: S3, our rows and the Uniware mirror have to succeed or
      // unwind together, which they can't if the client drives them separately.
      // Its step events arrive as they happen, so each gets its own toast.
      const outcome = await commitInvoice(file, toInwardPayload(form, rows), (e) => {
        if (e.status === "start") { setSubmitStep(e.step); return }
        if (e.status === "ok")      toast({ title: STEP_LABEL[e.step], description: e.message, variant: "success" })
        if (e.status === "skipped") toast({ title: STEP_LABEL[e.step], description: e.message, variant: "info" })
        if (e.status === "failed")  toast({ title: `${STEP_LABEL[e.step]} failed`, description: e.message, variant: "error" })
      })

      if (!outcome.ok) {
        // Everything before the failing step was rolled back, so the review is
        // still valid — leave the dialog open to retry.
        setError(outcome.error ?? "Something went wrong. Nothing was saved.")
        return
      }

      // Filed. Mark it before clearing so closeAndReset's flush stays off, then
      // drop the checkpoint and close — this runs after the email step, which
      // is the last event commitInvoice waits for.
      committedRef.current = true
      await clearDraft()
      setDraft(null)
      onCreated()
      closeAndReset()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Please try again.")
    } finally {
      setSubmitStep("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) closeAndReset() }}>
      <DialogContent
        className={cn(
          isReview
            // Full screen: the base DialogContent is a centred, translated box,
            // so left/top/translate all have to be neutralised, not just sized over.
            ? "inset-0 left-0 top-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-0 p-4"
            : "max-w-lg"
        )}
      >
        <DialogHeader className={cn(isReview && "mb-2 shrink-0")}>
          <DialogTitle className={cn(isReview && "flex flex-wrap items-baseline gap-x-2")}>
            {isReview ? (
              <>
                Review
                <span className="font-mono text-base font-medium text-primary">{form.invoiceNo || "this invoice"}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {rows.length} line item{rows.length === 1 ? "" : "s"}
                </span>
              </>
            ) : "Add Invoice"}
          </DialogTitle>
          <DialogDescription>
            {isReview
              ? "Check the parsed fields against the original, correct anything wrong, then create the inward POs."
              : "Upload a supplier invoice PDF. It's read automatically, and you review every field before any PO is created."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Pick ─────────────────────────────────────────────────────────── */}
        {phase === "pick" && (
          <div className="grid gap-3 py-2">
            {draft && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-primary">
                  <History className="h-3.5 w-3.5 shrink-0" /> Unfinished review
                </p>
                <p className="mt-2 truncate font-medium">{draft.fileName}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {draft.rows.length > 0 && <>{draft.rows.length} line item{draft.rows.length === 1 ? "" : "s"} · </>}
                  saved {savedAgo(draft.savedAt)}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" onClick={() => resumeDraft(draft)}>Resume review</Button>
                  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={discardDraft}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]) }}
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-accent/40",
                draft ? "py-5" : "py-10"
              )}
            >
              {!draft && <FileUp className="h-6 w-6" />}
              <span className="font-medium text-foreground">
                {draft ? "Start a new invoice instead" : "Choose a PDF invoice"}
              </span>
              <span className="text-xs">
                {draft ? "Replaces the unfinished review" : "or drop it here — max 10 MB"}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = "" }}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {/* ── Parsing ──────────────────────────────────────────────────────── */}
        {phase === "parsing" && (
          <div className="grid gap-3 py-6">
            {error ? (
              <>
                <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="text-sm">
                    <p className="font-medium text-destructive">Couldn&apos;t read this invoice</p>
                    <p className="mt-1 text-muted-foreground">{error}</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setError(""); setPhase("pick") }}>
                    Choose another file
                  </Button>
                  <Button onClick={() => { if (file) void runParse(file) }} disabled={!file}>
                    <RotateCw className="h-3.5 w-3.5" /> Retry parsing
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span className="truncate" title={file?.name}>
                    Reading {file?.name || "the invoice"}…
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{elapsed}s</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Extraction usually takes about a minute. Nothing is saved yet — the invoice is
                  stored only once you create the inward POs.
                </p>
              </>
            )}
          </div>
        )}

        {/* ── Review: PDF left, editable fields right ──────────────────────── */}
        {isReview && (
          <>
            <div
              ref={split.containerRef}
              className={cn("flex min-h-0 flex-1 max-lg:flex-col max-lg:gap-3", split.dragging && "select-none")}
            >
              {/* Original — the browser's own viewer gives scroll, zoom and page
                  nav free. `!w-full` at <lg beats the inline split width. */}
              <div
                style={{ width: `${split.pct}%` }}
                className="min-h-75 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/30 max-lg:h-100 max-lg:!w-full"
              >
                {pdfUrl ? (
                  <iframe
                    src={pdfUrl}
                    title="Original invoice"
                    // An iframe swallows pointer events, so a drag crossing it
                    // would stall mid-way without this.
                    className={cn("h-full w-full", split.dragging && "pointer-events-none")}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Preview unavailable — the parsed fields are still editable.
                  </div>
                )}
              </div>

              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize preview"
                onPointerDown={split.startDrag}
                onDoubleClick={split.reset}
                title="Drag to resize · double-click to reset"
                className={cn(
                  "group relative mx-1 w-1.5 shrink-0 cursor-col-resize rounded-full bg-border transition-colors hover:bg-primary max-lg:hidden",
                  split.dragging && "bg-primary"
                )}
              >
                {/* Widens the grab target without widening the visible bar */}
                <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
              </div>

              {/* @container, not viewport breakpoints: this pane's width is set by
                  the split drag, so the field grid has to respond to the pane. */}
              <div className="@container min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <InvoiceFields
                  form={form}
                  setField={setField}
                  onChangeMfg={changeMfg}
                  mfgOptions={mfgOptions}
                  warehouseOptions={warehouseOptions}
                  lineSum={lineSum}
                  extra={extra}
                  setExtra={setExtra}
                />

                <InvoiceLineItems
                  rows={rows}
                  setRow={(i, field, value) =>
                    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))}
                  addRow={() => setRows((prev) => [...prev, emptyRow()])}
                  removeRow={(i) => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                  rematch={() => applyFifo(openPos)}
                  skuOptions={skuOptions}
                  openPos={openPos}
                  mfgId={form.mfgId}
                />
              </div>
            </div>

            {/* Commit bar — one blocking list, then what pressing the button does. */}
            <div className="mt-3 shrink-0 border-t border-border pt-3">
              {/* What worked, beside what didn't. The dialog used to report only
                  problems, which left "nothing is wrong" and "nothing has been
                  checked" looking exactly alike — and the FIFO match in
                  particular does real work the user never asked for and can't
                  otherwise see. */}
              {(matched.skuTotal > 0 || matched.mfgMatched) && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {matched.mfgMatched && matched.parsedFrom && (
                    <MatchChip title={`Invoice says "${matched.parsedFrom}"`}>Manufacturer matched</MatchChip>
                  )}
                  {matched.skuTotal > 0 && matched.skusMatched === matched.skuTotal && (
                    <MatchChip>All {matched.skuTotal} SKUs matched</MatchChip>
                  )}
                  {matched.skuTotal > 0 && matched.skusMatched > 0 && matched.skusMatched < matched.skuTotal && (
                    <MatchChip>{matched.skusMatched} of {matched.skuTotal} SKUs matched</MatchChip>
                  )}
                  {matched.allocated > 0 && (
                    <MatchChip title="Oldest PO raise date first">
                      {matched.allocated} PO{matched.allocated === 1 ? "" : "s"} matched by FIFO
                    </MatchChip>
                  )}
                </div>
              )}
              {problems.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {problems.length} to fix
                  </span>
                  {/* Chips, not one joined sentence — six problems ran together
                      into a wall nobody read to the end of. */}
                  {problems.map((p) => (
                    <span
                      key={p}
                      className="rounded border border-amber-400/60 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}
              {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-sm">
                  {problems.length > 0 ? (
                    <span className="text-muted-foreground">Fix the items above to continue.</span>
                  ) : (
                    <>
                      <span className="font-medium">{form.invoiceNo || "This invoice"}</span>
                      {form.destination && <span className="text-muted-foreground"> → {form.destination}</span>}
                      <span className="text-muted-foreground">
                        {" · "}{form.currency || "INR"}{" "}
                        {lineSum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                      </span>
                    </>
                  )}
                </p>
                <Button variant="outline" onClick={closeAndReset} disabled={submitting}>Cancel</Button>
                <Button size="lg" onClick={handleSubmit} disabled={submitting || problems.length > 0}>
                  {submitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {submitStep ? STEP_PROGRESS[submitStep] : "Working…"}
                    </>
                  ) : commitLabel(rows.length, receiveCount)}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A confirmation, shaped like the problem chips beside it so the two read as
 *  one ledger rather than two unrelated widgets. */
function MatchChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
    >
      <Check className="h-3 w-3 shrink-0" />
      {children}
    </span>
  )
}

/** The button states its own outcome: "Create 2 POs · receive against 1". */
function commitLabel(total: number, receiveCount: number): string {
  const creates = total - receiveCount
  const pos = (n: number) => `${n} PO${n === 1 ? "" : "s"}`
  if (creates > 0 && receiveCount > 0) return `Create ${pos(creates)} · receive against ${receiveCount}`
  if (receiveCount > 0)               return `Receive against ${pos(receiveCount)}`
  return `Create ${creates} inward PO${creates === 1 ? "" : "s"}`
}
