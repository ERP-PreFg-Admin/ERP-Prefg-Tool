"use client"

// Add Invoice → inward POs.
//
// Three phases in one dialog: pick a PDF, parse it with Nanonets, then review
// the parsed fields side by side with the original before anything is written.
//
// Nothing is persisted until the user clicks "Create Inward POs" — the PDF is
// posted straight to the parser and previewed from a local blob URL, and the
// S3 upload happens as the first step of submit. Abandoning a review leaves no
// stored file behind.
//
// This file is the orchestration only. The form model and its rules live in
// invoice-form.ts, the requests in invoice-api.ts, and the two halves of the
// review pane in InvoiceFields.tsx / InvoiceLineItems.tsx.

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, FileUp, Loader2, RotateCw } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { OpenPoOption } from "@/types/invoice"
import type { MfgOption, SkuOption, WarehouseOption } from "../po-procurement/po-types"
import {
  EMPTY_FORM, MAX_BYTES, collectProblems, emptyRow, formFromParsed, poOptionsFor,
  rowsFromParsed, sumLineItems, toInwardPayload,
  type InvoiceForm, type Row,
} from "./invoice-form"
import { createInwardPos, fetchOpenPos, parseInvoiceFile, uploadInvoice } from "./invoice-api"
import { InvoiceFields } from "./InvoiceFields"
import { InvoiceLineItems } from "./InvoiceLineItems"
import { useSplitPane } from "./useSplitPane"

type Phase = "pick" | "parsing" | "review"

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
  const [progress, setProgress] = useState(0)
  /** "" when idle; otherwise which step of submit is running, for the button. */
  const [submitStep, setSubmitStep] = useState<"" | "uploading" | "creating">("")

  /** Held in memory for the whole review — it's the only copy until submit. */
  const [file, setFile]     = useState<File | null>(null)
  const [pdfUrl, setPdfUrl] = useState("")

  const [form, setForm]   = useState<InvoiceForm>(EMPTY_FORM)
  const [rows, setRows]   = useState<Row[]>([])
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [openPos, setOpenPos] = useState<OpenPoOption[]>([])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const xhrRef       = useRef<XMLHttpRequest | null>(null)
  const split        = useSplitPane(50)

  const submitting = submitStep !== ""
  const isReview   = phase === "review"
  const busy       = phase === "parsing" || submitting

  function setField<K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function reset() {
    setPhase("pick"); setError(""); setElapsed(0); setProgress(0); setSubmitStep("")
    // Blob URLs are held by the document until explicitly revoked; without this
    // every reviewed invoice leaks its full size for the life of the tab.
    setPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return "" })
    setFile(null)
    setForm(EMPTY_FORM); setRows([]); setExtra({}); setOpenPos([])
    split.reset()
  }

  /** Radix keeps this component mounted between openings, so the form has to be
   *  cleared explicitly or the next invoice opens showing the last one's data.
   *  Done on the way out rather than in an open-effect — resetting in an effect
   *  renders the stale form for a frame first. */
  function closeAndReset() {
    xhrRef.current?.abort()
    reset()
    onClose()
  }

  // Elapsed counter — a minute of "Parsing…" with no moving number reads as a hang.
  useEffect(() => {
    if (phase !== "parsing") return
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  // Abort an in-flight upload if the dialog is dismissed mid-transfer.
  useEffect(() => () => xhrRef.current?.abort(), [])

  // Reference-PO options follow the manufacturer. Refetched rather than filtered
  // client-side because the full open-PO set across all manufacturers is large.
  // Only the fetch lives here — clearing happens in changeMfg, at the event, so
  // this never calls setState synchronously on the way in.
  useEffect(() => {
    if (phase !== "review" || !form.mfgId) return
    let cancelled = false
    void fetchOpenPos(form.mfgId).then((pos) => { if (!cancelled) setOpenPos(pos) })
    return () => { cancelled = true }
  }, [form.mfgId, phase])

  /** Switching manufacturer invalidates both the PO list and every reference
   *  already chosen from it — they belonged to the previous manufacturer. */
  function changeMfg(value: string) {
    setField("mfgId", value)
    setOpenPos([])
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
      const parsed = await parseInvoiceFile(target)
      // Every value here is a suggestion; the review step exists to override it.
      setForm(formFromParsed(parsed, mfgOptions, warehouseOptions))
      setRows(rowsFromParsed(parsed, skuOptions))
      setExtra(parsed.extra ?? {})
      setPhase("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invoice parsing failed.")
    }
  }

  // ── Phase 3: validate + create ────────────────────────────────────────────
  const poById   = useMemo(() => new Map(openPos.map((p) => [String(p.id), p])), [openPos])
  const problems = useMemo(() => collectProblems(form, rows, poById), [form, rows, poById])
  const lineSum  = useMemo(() => sumLineItems(rows), [rows])
  const receiveCount = useMemo(() => rows.filter((r) => r.reference_po_id).length, [rows])

  async function handleSubmit() {
    if (problems.length > 0 || !file) return
    setError("")
    try {
      // Store the PDF only now that the user has committed. If this fails,
      // nothing is created — better than POs pointing at a missing document.
      setSubmitStep("uploading")
      setProgress(0)
      const key = await uploadInvoice(file, setProgress, (xhr) => { xhrRef.current = xhr })

      setSubmitStep("creating")
      const { count, receivedCount } = await createInwardPos(toInwardPayload(form, rows, key))

      const parts = [
        count > 0 ? `${count} inward PO${count === 1 ? "" : "s"} created` : "",
        receivedCount > 0 ? `${receivedCount} PO${receivedCount === 1 ? "" : "s"} received against` : "",
      ].filter(Boolean)
      toast({ title: parts.join(" · ") || "Invoice processed", variant: "success" })
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
          <DialogTitle>Add Invoice</DialogTitle>
          <DialogDescription>
            {isReview
              ? "Check the parsed fields against the original, correct anything wrong, then create the inward POs."
              : "Upload a supplier invoice PDF. It's read automatically, and you review every field before any PO is created."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Pick ─────────────────────────────────────────────────────────── */}
        {phase === "pick" && (
          <div className="grid gap-3 py-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]) }}
              className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input py-10 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-accent/40"
            >
              <FileUp className="h-6 w-6" />
              <span className="font-medium text-foreground">Choose a PDF invoice</span>
              <span className="text-xs">or drop it here — max 10 MB</span>
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

              <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1">
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
                  skuOptions={skuOptions}
                  openPos={openPos}
                  mfgId={form.mfgId}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 border-t border-border pt-3">
              <div className="min-w-0 flex-1 text-xs">
                {error ? (
                  <span className="text-destructive">{error}</span>
                ) : problems.length > 0 ? (
                  <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-500">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {problems.join(" ")}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{summarise(rows.length, receiveCount)}</span>
                )}
              </div>
              <Button variant="outline" onClick={closeAndReset} disabled={submitting}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={submitting || problems.length > 0}>
                {submitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {submitStep === "uploading" ? `Storing invoice… ${progress}%` : "Creating…"}
                  </>
                ) : "OK — Create Inward POs"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** "Creates 2 inward POs and receives against 1 existing PO." */
function summarise(total: number, receiveCount: number): string {
  const creates = total - receiveCount
  const parts: string[] = []
  if (creates > 0) parts.push(`Creates ${creates} inward PO${creates === 1 ? "" : "s"}`)
  if (receiveCount > 0) parts.push(`receives against ${receiveCount} existing PO${receiveCount === 1 ? "" : "s"}`)
  return parts.length ? parts.join(" and ") + "." : ""
}
