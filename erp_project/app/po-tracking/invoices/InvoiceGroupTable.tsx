"use client"

// The invoice-shaped view of inwarding: one row per supplier invoice, expanding
// to the line items it recorded and the POs each line resolved to.
//
// This is the view that makes the two PO shapes legible. Our own POs are one
// SKU to one manufacturer; a supplier invoice is one document covering many
// SKUs, which inwarding turns into one inward PO per SKU. Listing those POs
// flat hides the document they came from — grouping restores it.
//
// The invoice row carries the Uniware PO code, because Uniware holds ONE PO per
// invoice — it belongs to the document, not to a line. Each line still shows
// the order its receipt was credited to, which is the per-line fact: two lines
// of the same SKU can settle two different open POs.
//
// Extracted from InvoiceHistoryDialog so the dialog and /po-tracking/invoices
// render the same table rather than two that drift.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { SectionHead } from "../po-inwarding/InvoiceFields"
import UniwareStatusBadge from "../UniwareStatusBadge"
import type { InvoiceHistoryHeader, InvoiceHistoryItem, InvoiceGrnLine, InvoiceDocument } from "@/types/invoice"
import { IST, todayIST } from "@/lib/date"
import type { MatchBadge } from "@/lib/invoice/three-way"
import { PaymentCell, ThreeWayChips, matchOf } from "./ThreeWayCells"
import ThreeWayDialog from "./ThreeWayDialog"

const num = (v: unknown) => (v == null || v === "" ? null : Number(v))

const money = (v: unknown) => {
  const n = num(v)
  return n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 })
}

const qty = (v: unknown) => {
  const n = num(v)
  // Quantities are DECIMAL(12,3) but whole units in practice — don't show ".000".
  return n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 3 })
}

const shortDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: IST }) : "—"

/** Distinct receipts across a flat list of receipt lines. */
const grnCount = (lines?: InvoiceGrnLine[]) => new Set((lines ?? []).map((l) => l.grn_code)).size

/**
 * The IST calendar day of a timestamp, as "YYYY-MM-DD".
 *
 * IST and not UTC, because `shortDate` above renders this row's dates in IST —
 * and a timestamp after 18:30 IST falls on the NEXT UTC day. A UTC-based ageing
 * would then disagree with the date printed beside it, which is worse than being
 * absent. `en-CA` is the locale that formats as ISO.
 *
 * Takes only a date STRING from the row. Do not pass an epoch as a string:
 * `new Date("1787206929000")` is an Invalid Date — JS parses bare epoch strings
 * as nothing — and this would then return null, showing every row as "—" with
 * no error anywhere. Use todayIST() for "now".
 */
const istDay = (v: string | null): string | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: IST })
}

/**
 * How old the invoice is TODAY: today − invoice date, in whole days.
 *
 * Not "how long it took to enter" — this keeps counting after the invoice is
 * recorded, so it is the age of an open obligation rather than a one-off measure
 * of desk lag. It therefore changes every midnight without the row changing.
 *
 * `todayIST()` rather than a hand-rolled today: `new Date().toISOString()` is
 * the UTC date, still yesterday until 05:30 IST — a bug that reads correctly on
 * a laptop in India and wrongly in the UTC container, which is exactly why that
 * helper exists.
 *
 * Both days are parsed as UTC midnight of their IST date, so the subtraction is
 * whole days with no clock time to round. India has no DST, so no hour is lost.
 */
function ageingDays(inv: InvoiceHistoryHeader): number | null {
  const from = istDay(inv.invoice_date)
  if (!from) return null
  return Math.round((Date.parse(`${todayIST()}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Ageing, in days.
 *
 * No threshold is coloured: "late" is a policy nobody has stated, and inventing
 * one here would make the column assert something the business hasn't decided.
 * A NEGATIVE is different — the invoice is dated in the FUTURE, which is a data
 * error rather than a slow month, so that one is called out.
 */
function AgeingCell({ inv }: { inv: InvoiceHistoryHeader }) {
  const days = ageingDays(inv)
  if (days == null) {
    return <span className="text-muted-foreground" title="No invoice date recorded">—</span>
  }
  if (days < 0) {
    return (
      <span
        className="font-medium text-amber-700 dark:text-amber-400"
        title="Invoice is dated in the future — check the invoice date"
      >
        {days}d
      </span>
    )
  }
  return (
    <span className="text-muted-foreground" title={`Invoice dated ${shortDate(inv.invoice_date)}`}>
      {days}d
    </span>
  )
}

/**
 * The receipts booked against one invoice, grouped by GRN.
 *
 * A different document from the line items, which is why it is a separate view
 * rather than more columns: the lines are what the manufacturer billed, a
 * receipt is what the warehouse booked, and one receipt can cover several lines
 * while several receipts can settle one. Batch and expiry here come from the
 * RECEIPT, not from our invoice line — when the two disagree, that is the point.
 */
function GrnSection({ lines }: { lines: InvoiceGrnLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="py-3 text-muted-foreground">
        No goods receipt synced against this invoice yet.
      </p>
    )
  }

  // Grouped in arrival order — the query already sorts newest receipt first, so
  // a Map preserves that without a second sort.
  const byGrn = new Map<string, InvoiceGrnLine[]>()
  for (const l of lines) {
    const g = byGrn.get(l.grn_code)
    if (g) g.push(l)
    else byGrn.set(l.grn_code, [l])
  }

  return (
    <div className="grid gap-2">
      {[...byGrn.entries()].map(([code, rows]) => {
        const accepted = rows.reduce((t, r) => t + Number(r.quantity ?? 0), 0)
        const rejected = rows.reduce((t, r) => t + Number(r.rejected_qty ?? 0), 0)
        // Only the priced lines contribute. A line with no rate is unknown
        // value, so it is left out of the total rather than counted as zero —
        // the same rule rejectedAmount() follows in lib/uniware/grn-totals.ts.
        const rejectedValue = rows.reduce(
          (t, r) => t + (r.po_unit_price == null ? 0 : Number(r.rejected_qty ?? 0) * Number(r.po_unit_price)), 0)
        const unpriced = rows.some((r) => r.po_unit_price == null)
        const head = rows[0]
        return (
          <div key={code} className="rounded-md border border-border">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-2 py-1.5 text-[11px]">
              <span className="font-mono font-medium">{code}</span>
              {head.status_code && <Badge variant="secondary">{head.status_code}</Badge>}
              <span className="text-muted-foreground">{shortDate(head.grn_created_at)}</span>
              {/* The warehouse's own reading of the supplier invoice number.
                  Worth showing because a mismatch against the invoice this sits
                  under is how a receipt lands on the wrong PO. */}
              {head.vendor_invoice_no && (
                <span className="text-muted-foreground">
                  inv <span className="font-mono">{head.vendor_invoice_no}</span>
                </span>
              )}
              <span className="ml-auto tabular-nums">
                <span className="font-medium">{qty(accepted)}</span>
                {rejected > 0 && (
                  <>
                    <span className="text-muted-foreground"> / </span>
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      {qty(rejected)} rejected
                      {rejectedValue > 0 && ` (₹${money(rejectedValue)})`}
                    </span>
                    {/* Said out loud, or the total silently understates the loss. */}
                    {unpriced && (
                      <span className="ml-1 text-muted-foreground" title="Some receipt lines have no rate on their inward PO">
                        + unpriced
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="[&>th]:whitespace-nowrap [&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                  <th className="w-8">#</th>
                  <th>SKU</th>
                  <th>Inward PO</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th className="text-right">Accepted</th>
                  <th className="text-right">Rejected</th>
                  {/* Our own rate off the inward PO — the receipt has none. */}
                  <th className="text-right">Rate</th>
                  <th className="text-right">Accepted ₹</th>
                  <th className="text-right">Rejected ₹</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.grn_code}-${r.line_no}`} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
                    <td className="text-muted-foreground">{r.line_no}</td>
                    <td className="font-medium">{r.sku_code ?? "—"}</td>
                    {/* No PO is a real finding, not a blank: the warehouse
                        received a SKU we never raised an order for. */}
                    <td className="whitespace-nowrap font-mono">
                      {r.po_no ?? (
                        <span className="text-amber-700 dark:text-amber-400" title="Received against no purchase order of ours">
                          unmatched
                        </span>
                      )}
                    </td>
                    <td>{r.batch_code ?? "—"}</td>
                    <td>{r.expiry ?? "—"}</td>
                    <td className="text-right tabular-nums">{qty(r.quantity)}</td>
                    <td className={cn(
                      "text-right tabular-nums",
                      Number(r.rejected_qty ?? 0) > 0 && "font-medium text-amber-700 dark:text-amber-400"
                    )}>
                      {qty(r.rejected_qty)}
                    </td>
                    {/* A dash, never ₹0: an unpriced line is unknown value, and
                        "₹0" beside 150 rejected units reads as "no loss". */}
                    <td className="text-right tabular-nums text-muted-foreground">
                      {r.po_unit_price == null ? "—" : money(r.po_unit_price)}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.po_unit_price == null ? "—" : money(Number(r.quantity ?? 0) * Number(r.po_unit_price))}
                    </td>
                    <td className={cn(
                      "text-right tabular-nums",
                      Number(r.rejected_qty ?? 0) > 0 && r.po_unit_price != null &&
                        "font-medium text-amber-700 dark:text-amber-400"
                    )}>
                      {r.po_unit_price == null ? "—" : money(Number(r.rejected_qty ?? 0) * Number(r.po_unit_price))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The documents living on this invoice's Uniware PO, mirrored into our S3.
 *
 * 'uniware' is what the warehouse attached — the signed invoice copy is the one
 * anyone opening this is usually after — and 'erp' is our own invoice PDF that
 * the push put there, shown so the list matches what Uniware holds rather than
 * hiding half of it. Both open through the same presign the Original column uses.
 */
function DocumentsSection({
  documents, onOpen,
}: { documents: InvoiceDocument[]; onOpen: (key: string) => void }) {
  if (documents.length === 0) {
    return (
      <p className="py-3 text-muted-foreground">
        No documents synced for this invoice yet. Use “Sync Documents” to pull the warehouse’s copy.
      </p>
    )
  }
  return (
    <ul className="grid gap-1.5">
      {documents.map((d) => (
        <li key={d.id} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <button
            onClick={() => onOpen(d.s3_key)}
            className="min-w-0 flex-1 truncate text-left text-primary underline-offset-2 hover:underline"
            title={d.filename}
          >
            {d.filename}
          </button>
          {/* Which way it moved — "From warehouse" is the one worth pulling. */}
          <Badge variant="secondary">{d.source === "erp" ? "Pushed" : "From warehouse"}</Badge>
          {d.uniware_uploaded_by && (
            <span className="hidden max-w-40 truncate text-[11px] text-muted-foreground sm:inline" title={d.uniware_uploaded_by}>
              {d.uniware_uploaded_by}
            </span>
          )}
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </li>
      ))}
    </ul>
  )
}

export default function InvoiceGroupTable({
  search = "",
  filterQuery = "",
  pageSize = 25,
  reloadKey = 0,
  emptyHint,
  className,
  matchFilter,
  onTally,
}: {
  /** Server-side filter on invoice_no / manufacturer name. */
  search?: string
  /** The rest of the filters as a query string, e.g. "mfgCode=MFG01&dateTo=…".
   *  A string rather than an object on purpose: it compares by value, so the
   *  fetch effect below doesn't re-run on every parent render. */
  filterQuery?: string
  pageSize?: number
  /** Bump to refetch the current page. Rows are fetched client-side, so
   *  router.refresh() can't reach them — the Uniware sync needs this to make the
   *  statuses it just wrote appear. */
  reloadKey?: number
  /** Shown when there are no invoices — the two hosts word this differently. */
  emptyHint?: React.ReactNode
  className?: string
  /** Match badges to keep. Empty = all. Applied to the PAGE, not the query —
   *  the match is derived in TS, so the server can't filter on it. */
  matchFilter?: MatchBadge[]
  /** Reports this page's badge tally up, so the host can caption it honestly. */
  onTally?: (t: { shown: number; counts: Partial<Record<MatchBadge, number>> }) => void
}) {
  const [invoices, setInvoices] = useState<InvoiceHistoryHeader[]>([])
  const [total, setTotal]       = useState(0)
  const [offset, setOffset]     = useState(0)
  // Starts true: the mount-effect fetches immediately, and flipping this on
  // inside the effect would be a synchronous setState during render.
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState("")

  /** Expanded invoice id → its lines (undefined while loading). */
  const [expanded, setExpanded] = useState<number | null>(null)
  /** The row whose three-way drilldown is open. */
  const [matchFor, setMatchFor] = useState<InvoiceHistoryHeader | null>(null)
  const [items, setItems]       = useState<Record<number, InvoiceHistoryItem[]>>({})
  /** Receipt lines for the expanded invoice, keyed like `items`. */
  const [grns, setGrns] = useState<Record<number, InvoiceGrnLine[]>>({})
  /** Uniware PO documents for the expanded invoice, keyed like `items`. */
  const [documents, setDocuments] = useState<Record<number, InvoiceDocument[]>>({})
  /** Which table the expansion shows. Reset on every open — the lines are what
   *  someone expanding an invoice is looking for by default; the receipts and
   *  documents are the follow-up questions. */
  const [view, setView] = useState<"lines" | "grns" | "documents">("lines")
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError]     = useState("")

  /** Pure fetcher — holds no state, so callers can drive it from an effect
   *  without tripping react-hooks/set-state-in-effect. Throws on failure. */
  const fetchPage = useCallback(async (nextOffset: number) => {
    // Read so `reloadKey` is a real dependency and not an "unnecessary" one: a
    // bump has to change this callback's identity, which is what re-runs the
    // effect below and refetches the page.
    void reloadKey
    const params = new URLSearchParams(filterQuery)
    params.set("limit", String(pageSize))
    params.set("offset", String(nextOffset))
    if (search.trim()) params.set("search", search.trim())
    const res = await fetch(`/api/v1/purchase-orders/invoice?${params}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? "Couldn't load invoices.")
    return data as { invoices?: InvoiceHistoryHeader[]; total?: number }
  }, [pageSize, search, filterQuery, reloadKey])

  const apply = useCallback((data: { invoices?: InvoiceHistoryHeader[]; total?: number }, at: number) => {
    setError("")
    setInvoices(data.invoices ?? [])
    setTotal(Number(data.total ?? 0))
    setOffset(at)
  }, [])

  // Loads on mount and whenever the search or filters change — a new search has
  // to start at page 1, so this deliberately resets the offset rather than keeping it.
  // State is only touched inside the promise callbacks, never synchronously.
  useEffect(() => {
    let cancelled = false
    fetchPage(0)
      .then((d) => { if (!cancelled) apply(d, 0) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load invoices.")
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage, apply])

  /** Page change from a button — an event, so raising `loading` here is fine. */
  function goTo(nextOffset: number) {
    setLoading(true)
    fetchPage(nextOffset)
      .then((d) => apply(d, nextOffset))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load invoices."))
      .finally(() => setLoading(false))
  }

  /** Re-read the current page in place, keeping the offset — a verification
   *  changes a badge, not which invoices match. */
  const refreshPage = useCallback(
    () => fetchPage(offset).then((d) => apply(d, offset)).catch(() => {}),
    [fetchPage, offset, apply]
  )

  /** Separate from toggle so the error state has something to retry. */
  async function loadItems(id: number) {
    setItemsError("")
    setItemsLoading(true)
    try {
      const res = await fetch(`/api/v1/purchase-orders/invoice/${id}`)
      const data = await res.json().catch(() => ({}))
      // A failed fetch used to fall through to "No line items recorded." — an
      // invoice with no lines and an unreachable API are not the same thing,
      // and only one of them means the data is wrong.
      if (!res.ok) throw new Error(data.error ?? "Couldn't load these line items.")
      setItems((prev) => ({ ...prev, [id]: data.items ?? [] }))
      setGrns((prev) => ({ ...prev, [id]: data.grns ?? [] }))
      setDocuments((prev) => ({ ...prev, [id]: data.documents ?? [] }))
    } catch (e: unknown) {
      setItemsError(e instanceof Error ? e.message : "Couldn't load these line items.")
    } finally {
      setItemsLoading(false)
    }
  }

  function toggle(id: number) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    setView("lines")
    setItemsError("")
    if (!items[id]) void loadItems(id) // lines don't change once written, so cache
  }

  // Matched once per page, not per cell: the chips, the badge, the filter and
  // the tally must all read the same verdict for a row.
  const matched = useMemo(
    () => invoices.map((inv) => ({ inv, m: matchOf(inv) })),
    [invoices]
  )
  const visible = useMemo(
    () => (matchFilter?.length ? matched.filter((r) => matchFilter.includes(r.m.badge)) : matched),
    [matched, matchFilter]
  )

  // Reported in an effect, not during render — this sets state in the parent.
  useEffect(() => {
    if (!onTally) return
    const counts: Partial<Record<MatchBadge, number>> = {}
    for (const { m } of matched) counts[m.badge] = (counts[m.badge] ?? 0) + 1
    onTally({ shown: matched.length, counts })
  }, [matched, onTally])

  /** Open the original PDF via a short-lived presigned URL. */
  async function openOriginal(key: string) {
    // Opened synchronously and pointed at the URL once it resolves — a popup
    // blocker would kill window.open() called after an await.
    const tab = window.open("", "_blank")
    try {
      const res = await fetch(`/api/v1/files/presign?key=${encodeURIComponent(key)}&expiresIn=3600`)
      const data = await res.json().catch(() => ({}))
      if (data.url && tab) tab.location.href = data.url
      else { tab?.close(); setError("Couldn't open the original invoice.") }
    } catch {
      tab?.close()
      setError("Couldn't open the original invoice.")
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[52rem] text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
              {/* Manufacturer and Entered each carry two facts in one column —
                  code under name, date under person. Ten columns didn't fit
                  without horizontal scroll, and the pairs read better stacked
                  than side by side. */}
              <th className="w-8" />
              <th>Invoice</th>
              {/* The same document's identity in the other system, so it sits
                  beside our own number rather than down in the lines: Uniware
                  holds ONE PO per invoice, not one per line. */}
              <th>Uniware Code</th>
              {/* Unicommerce's own status for that PO, and the button that asks
                  again. On the invoice row for the same reason the code is. */}
              <th>Uniware Status</th>
              {/* The reconciliation, in one place: ordered, billed, received.
                  Next to the status because it answers what the status only
                  hints at — "approved" says nothing about whether goods
                  arrived. Click it for the verdict and the documents; a column
                  of its own repeated what the chips and the dialog already say. */}
              <th>3-way (PO · INV · GRN)</th>
              {/* Derived from the match, not a payment record — the ERP stores
                  no payment state. See PaymentStatus in lib/invoice/three-way.ts. */}
              <th>Payment</th>
              <th>Manufacturer</th>
              <th>Destination</th>
              <th className="text-right">Total</th>
              <th className="text-center">Lines</th>
              <th>Entered</th>
              {/* Today − the invoice's own date, so it keeps counting while the
                  invoice is open. Sits beside Entered because the two together
                  say how much of the age was ours: entered late, or simply old. */}
              <th className="text-right">Ageing</th>
              <th className="w-20">Original</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={13} className="px-2 py-8 text-center text-muted-foreground">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </td></tr>
            )}

            {!loading && visible.length === 0 && (
              <tr><td colSpan={13} className="px-2 py-8 text-center text-muted-foreground">
                {invoices.length > 0
                  ? "No invoices on this page carry that match status."
                  : search.trim()
                  ? `No invoices match “${search.trim()}”.`
                  : filterQuery
                  ? "No invoices match these filters."
                  : emptyHint ?? "No invoices read yet."}
              </td></tr>
            )}

            {!loading && visible.map(({ inv, m }) => {
              const isOpen = expanded === inv.id
              const lines  = items[inv.id]
              return (
                // Fragment carries the key: it's the array element, not the rows.
                <Fragment key={inv.id}>
                  <tr
                    onClick={() => toggle(inv.id)}
                    className={cn(
                      "cursor-pointer border-t border-border [&>td]:px-2 [&>td]:py-2",
                      isOpen ? "bg-accent/50" : "hover:bg-accent/30"
                    )}
                  >
                    <td>
                      {/* A real button so the rows are keyboard-reachable — the
                          row's own onClick can't be tabbed to. stopPropagation
                          or the row handler would toggle it straight back. */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggle(inv.id) }}
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} invoice ${inv.invoice_no}`}
                        className="rounded p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td>
                      <div className="font-medium">{inv.invoice_no}</div>
                      <div className="text-[11px] text-muted-foreground">{shortDate(inv.invoice_date)}</div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[11px]">
                      {inv.uniware_po_code ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td>
                      <UniwareStatusBadge
                        status={inv.uniware_status}
                        syncedAt={inv.uniware_synced_at}
                      />
                    </td>
                    <td className="whitespace-nowrap">
                      <ThreeWayChips m={m} onOpen={() => setMatchFor(inv)} />
                    </td>
                    <td className="whitespace-nowrap">
                      <PaymentCell m={m} />
                    </td>
                    <td className="max-w-56">
                      <div className="truncate" title={inv.mfg_name}>{inv.mfg_name}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{inv.mfg_code}</div>
                    </td>
                    <td>{inv.destination ?? "—"}</td>
                    <td className="whitespace-nowrap text-right font-medium tabular-nums">
                      {money(inv.invoice_total)}
                    </td>
                    {/* Just the count. The "N recd" badge that used to sit here
                        said how many lines settled an existing PO — which is
                        nearly all of them on a normal invoice, so it carried no
                        signal, and it now competes with the Accepted / Rejected
                        column that reports what actually arrived. */}
                    <td className="whitespace-nowrap text-center">{inv.item_count ?? 0}</td>
                    <td className="max-w-36">
                      <div className="truncate">{inv.created_by_name ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground">{shortDate(inv.created_at)}</div>
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      <AgeingCell inv={inv} />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {inv.attachment_key ? (
                        <button
                          onClick={() => void openOriginal(inv.attachment_key!)}
                          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                        >
                          <FileText className="h-3 w-3" /> View
                          <ExternalLink className="h-2.5 w-2.5" />
                        </button>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="border-t border-border bg-muted/20">
                      <td colSpan={13} className="px-3 py-2">
                        {itemsLoading && !lines ? (
                          <div className="flex items-center gap-2 py-3 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading items…
                          </div>
                        ) : itemsError ? (
                          <div className="flex flex-wrap items-center gap-2 py-3">
                            <span className="text-destructive">{itemsError}</span>
                            <Button variant="outline" size="xs" onClick={() => void loadItems(inv.id)}>
                              <RotateCw className="h-3 w-3" /> Retry
                            </Button>
                          </div>
                        ) : !lines?.length ? (
                          <p className="py-3 text-muted-foreground">No line items recorded.</p>
                        ) : (
                          <div className="grid gap-2 rounded-lg border border-border bg-background p-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <SectionHead>
                                {view === "lines"
                                  ? `Line items (${lines.length})`
                                  : view === "grns"
                                  ? `Goods receipts (${grnCount(grns[inv.id])})`
                                  : `Documents (${documents[inv.id]?.length ?? 0})`}
                              </SectionHead>
                              {/* A select, not tabs: two options swapping one
                                  table for another inside an already dense row.
                                  The counts live in the options so the unchosen
                                  view still says how much is behind it. */}
                              <Select
                                aria-label="Which table to show"
                                value={view}
                                onChange={(e) => setView(e.target.value as "lines" | "grns" | "documents")}
                                className="h-7 py-0 text-[11px]"
                              >
                                <option value="lines">Line items ({lines.length})</option>
                                <option value="grns">Goods receipts ({grnCount(grns[inv.id])})</option>
                                <option value="documents">Documents ({documents[inv.id]?.length ?? 0})</option>
                              </Select>
                            </div>

                            {view === "documents" ? (
                              <DocumentsSection documents={documents[inv.id] ?? []} onOpen={openOriginal} />
                            ) : view === "grns" ? <GrnSection lines={grns[inv.id] ?? []} /> : (
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="[&>th]:whitespace-nowrap [&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                                  <th className="w-8">#</th>
                                  <th>SKU</th>
                                  <th>Product</th>
                                  <th>Batch</th>
                                  <th>Expiry</th>
                                  <th className="text-right">Qty</th>
                                  <th className="text-right">Rate</th>
                                  {/* Beside the invoice's own rate, because the
                                      two are written from each other at inward
                                      time — a difference means one was edited. */}
                                  <th className="text-right">PO Price</th>
                                  <th className="text-right">Line Total</th>
                                  {/* Billed to the left, ACCEPTED here — the
                                      pair on one row is the reconciliation.
                                      Keyed on this line's own inward PO, which
                                      is what grn_items_uniware.po_id joins on. */}
                                  <th className="text-right">Accepted</th>
                                  <th className="text-right">Rejected</th>
                                  {/* Unicommerce's own two, mirrored by the
                                      sync. Only these — received and rejected
                                      above already say the same thing from the
                                      goods receipts, and one quantity under two
                                      names makes a reader trust neither. */}
                                  <th className="text-right">Pending (UC)</th>
                                  <th className="text-right">QC Pass (UC)</th>
                                  <th>Received against</th>
                                  {/* The inward PO this line raised. Last,
                                      because it repeats across the lines of
                                      one SKU. */}
                                  <th>Inward PO</th>
                                </tr>
                              </thead>
                              <tbody>
                                {lines.map((li) => (
                                  <tr key={li.id} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
                                    <td className="text-muted-foreground">{li.line_no}</td>
                                    <td className="font-medium">
                                      {li.sku_code ?? "—"}
                                      {li.parsed_sku_code && li.parsed_sku_code !== li.sku_code && (
                                        <span className="ml-1 text-muted-foreground" title="As printed on the invoice">
                                          ({li.parsed_sku_code})
                                        </span>
                                      )}
                                    </td>
                                    <td className="max-w-56 truncate" title={li.sku_name ?? ""}>{li.sku_name ?? "—"}</td>
                                    <td>{li.batch ?? "—"}</td>
                                    <td>{li.expiry ?? "—"}</td>
                                    <td className="text-right tabular-nums">{qty(li.qty)}</td>
                                    <td className="text-right tabular-nums">{money(li.rate)}</td>
                                    {/* Amber when it disagrees with the invoice
                                        rate beside it — the same treatment the
                                        PO table gives invoice_rate vs
                                        unit_price, and for the same reason. */}
                                    <td className={cn(
                                      "text-right tabular-nums",
                                      li.po_unit_price != null && li.rate != null &&
                                        Number(li.po_unit_price) !== Number(li.rate)
                                        ? "font-medium text-amber-700 dark:text-amber-400"
                                        : "text-muted-foreground"
                                    )}>
                                      {money(li.po_unit_price)}
                                    </td>
                                    <td className="text-right tabular-nums">{money(li.total_amount)}</td>
                                    {/* Only meaningful against an inward PO —
                                        that is the key the receipts join on. A
                                        dash means "no PO", not "zero". */}
                                    <td className="text-right tabular-nums">
                                      {li.po_id == null
                                        ? <span className="text-muted-foreground">—</span>
                                        : qty(li.grn_accepted ?? 0)}
                                    </td>
                                    <td className={cn(
                                      "text-right tabular-nums",
                                      Number(li.grn_rejected ?? 0) > 0 && "font-medium text-amber-700 dark:text-amber-400"
                                    )}>
                                      {li.po_id == null
                                        ? <span className="text-muted-foreground">—</span>
                                        : qty(li.grn_rejected ?? 0)}
                                    </td>
                                    {/* NULL is "never asked", not zero — the
                                        sync stamps un_line_synced_at, so a dash
                                        here means Uniware has not answered about
                                        this line rather than reporting nothing
                                        outstanding. */}
                                    <td className="text-right tabular-nums text-muted-foreground">
                                      {li.un_line_synced_at ? qty(li.un_pending_qty ?? 0) : "—"}
                                    </td>
                                    <td className="text-right tabular-nums text-muted-foreground">
                                      {li.un_line_synced_at ? qty(li.un_qc_pass_qty ?? 0) : "—"}
                                    </td>
                                    <td className="whitespace-nowrap">
                                      {li.received_against_po_no ? (
                                        <>
                                          {li.received_against_po_no}
                                          <span className="ml-1 text-muted-foreground">
                                            ({qty(li.received_against_received_qty)}/{qty(li.received_against_qty)})
                                          </span>
                                        </>
                                      ) : <span className="text-muted-foreground">—</span>}
                                    </td>
                                    <td className="whitespace-nowrap font-mono">
                                      {li.po_no ?? <span className="text-muted-foreground">—</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex shrink-0 items-center gap-3 border-t border-border pt-3 text-xs">
        <span className="flex-1 text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span>
            : total > 0 ? `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}`
            : ""}
        </span>
        <Button
          variant="outline" size="sm"
          disabled={loading || offset === 0}
          onClick={() => goTo(Math.max(0, offset - pageSize))}
        >
          Previous
        </Button>
        <Button
          variant="outline" size="sm"
          disabled={loading || offset + pageSize >= total}
          onClick={() => goTo(offset + pageSize)}
        >
          Next
        </Button>
      </div>

      {/* Keyed so each invoice gets a fresh mount, which is what lets the dialog
          start in its loading state instead of setting it inside an effect. */}
      <ThreeWayDialog
        key={matchFor?.id ?? "none"}
        invoice={matchFor}
        onClose={() => setMatchFor(null)}
        // A sign-off changes the row's badge, and rows are fetched client-side,
        // so the list has to be told rather than refreshed by the router.
        onChanged={() => void refreshPage()}
      />
    </div>
  )
}
