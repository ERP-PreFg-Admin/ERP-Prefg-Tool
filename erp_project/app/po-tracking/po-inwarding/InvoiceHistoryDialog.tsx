"use client"

// Invoice History — every supplier invoice read through Add Invoice, the line
// items it produced, and the POs each line resolved to.
//
// A line can point at two POs: the inward PO it raised, and (when it was booked
// against an existing order) the PO whose received_qty it credited. Both are
// shown, because "which PO did this invoice line go to" has two answers and
// picking one would be misleading.

import { Fragment, useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, RotateCw } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { SectionHead } from "./InvoiceFields"
import type { InvoiceHistoryHeader, InvoiceHistoryItem } from "@/types/invoice"

const PAGE_SIZE = 25

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
  v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—"

export default function InvoiceHistoryDialog({
  open, onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [invoices, setInvoices] = useState<InvoiceHistoryHeader[]>([])
  const [total, setTotal]       = useState(0)
  const [offset, setOffset]     = useState(0)
  // Starts true: the open-effect fetches immediately, and flipping this on
  // inside the effect would be a synchronous setState during render.
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState("")

  /** Expanded invoice id → its lines (undefined while loading). */
  const [expanded, setExpanded] = useState<number | null>(null)
  const [items, setItems]       = useState<Record<number, InvoiceHistoryItem[]>>({})
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError]     = useState("")

  /** Pure fetcher — holds no state, so callers can drive it from an effect
   *  without tripping react-hooks/set-state-in-effect. Throws on failure. */
  const fetchPage = useCallback(async (nextOffset: number) => {
    const res = await fetch(`/api/purchase-orders/invoice?limit=${PAGE_SIZE}&offset=${nextOffset}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? "Couldn't load invoices.")
    return data as { invoices?: InvoiceHistoryHeader[]; total?: number }
  }, [])

  const apply = useCallback((data: { invoices?: InvoiceHistoryHeader[]; total?: number }, at: number) => {
    setError("")
    setInvoices(data.invoices ?? [])
    setTotal(Number(data.total ?? 0))
    setOffset(at)
  }, [])

  // Refetch on each opening — an invoice added since last time should show.
  // State is only touched inside the promise callbacks, never synchronously.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchPage(0)
      .then((d) => { if (!cancelled) apply(d, 0) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load invoices.")
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, fetchPage, apply])

  /** Page change from a button — an event, so raising `loading` here is fine. */
  function goTo(nextOffset: number) {
    setLoading(true)
    fetchPage(nextOffset)
      .then((d) => apply(d, nextOffset))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load invoices."))
      .finally(() => setLoading(false))
  }

  /** Radix keeps this mounted between openings, so clear on the way out rather
   *  than in an open-effect — the latter renders stale rows for a frame first. */
  function closeAndReset() {
    setExpanded(null)
    setItems({})
    setError("")
    setLoading(true) // so the next opening shows the spinner, not stale rows
    onClose()
  }

  /** Separate from toggle so the error state has something to retry. */
  async function loadItems(id: number) {
    setItemsError("")
    setItemsLoading(true)
    try {
      const res = await fetch(`/api/purchase-orders/invoice/${id}`)
      const data = await res.json().catch(() => ({}))
      // A failed fetch used to fall through to "No line items recorded." — an
      // invoice with no lines and an unreachable API are not the same thing,
      // and only one of them means the data is wrong.
      if (!res.ok) throw new Error(data.error ?? "Couldn't load these line items.")
      setItems((prev) => ({ ...prev, [id]: data.items ?? [] }))
    } catch (e: unknown) {
      setItemsError(e instanceof Error ? e.message : "Couldn't load these line items.")
    } finally {
      setItemsLoading(false)
    }
  }

  function toggle(id: number) {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    setItemsError("")
    if (!items[id]) void loadItems(id) // lines don't change once written, so cache
  }

  /** Open the original PDF via a short-lived presigned URL. */
  async function openOriginal(key: string) {
    // Opened synchronously and pointed at the URL once it resolves — a popup
    // blocker would kill window.open() called after an await.
    const tab = window.open("", "_blank")
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}&expiresIn=3600`)
      const data = await res.json().catch(() => ({}))
      if (data.url && tab) tab.location.href = data.url
      else { tab?.close(); setError("Couldn't open the original invoice.") }
    } catch {
      tab?.close()
      setError("Couldn't open the original invoice.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeAndReset() }}>
      <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col p-4">
        <DialogHeader className="mb-2 shrink-0">
          <DialogTitle className="flex flex-wrap items-baseline gap-x-2">
            Invoice History
            {total > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                {total} invoice{total === 1 ? "" : "s"}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            Every supplier invoice read on this page, the items it recorded, and the POs
            each line was booked to.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-200 text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                <th className="w-8" />
                <th>Invoice No</th>
                <th>Date</th>
                <th>Manufacturer</th>
                <th>Destination</th>
                <th className="text-right">Total</th>
                <th className="text-center">Lines</th>
                <th>Entered by</th>
                <th>Entered on</th>
                <th className="w-24">Original</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="px-2 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td></tr>
              )}

              {!loading && invoices.length === 0 && (
                <tr><td colSpan={10} className="px-2 py-8 text-center text-muted-foreground">
                  No invoices read yet. Close this and use Add Invoice to read the first one.
                </td></tr>
              )}

              {!loading && invoices.map((inv) => {
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
                      <td className="font-medium">{inv.invoice_no}</td>
                      <td className="whitespace-nowrap">{shortDate(inv.invoice_date)}</td>
                      <td className="max-w-48 truncate" title={inv.mfg_name}>{inv.mfg_code} — {inv.mfg_name}</td>
                      <td>{inv.destination ?? "—"}</td>
                      <td className="whitespace-nowrap text-right tabular-nums">{money(inv.invoice_total)}</td>
                      <td className="text-center">
                        {inv.item_count ?? 0}
                        {Number(inv.received_count) > 0 && (
                          <Badge variant="info" className="ml-1">{Number(inv.received_count)} recd</Badge>
                        )}
                      </td>
                      <td className="max-w-32 truncate">{inv.created_by_name ?? "—"}</td>
                      <td className="whitespace-nowrap">{shortDate(inv.created_at)}</td>
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
                        <td colSpan={10} className="px-3 py-2">
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
                              <SectionHead>{`Line items (${lines.length})`}</SectionHead>
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
                                    <th className="text-right">Line Total</th>
                                    <th>Inward PO</th>
                                    <th>Received against</th>
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
                                      <td className="text-right tabular-nums">{money(li.total_amount)}</td>
                                      <td className="whitespace-nowrap">
                                        {li.po_no ?? <span className="text-muted-foreground">—</span>}
                                        {li.po_status && (
                                          <span className="ml-1 text-muted-foreground">({li.po_status.replace(/_/g, " ")})</span>
                                        )}
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
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
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
              : total > 0 ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`
              : ""}
          </span>
          <Button
            variant="outline" size="sm"
            disabled={loading || offset === 0}
            onClick={() => goTo(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline" size="sm"
            disabled={loading || offset + PAGE_SIZE >= total}
            onClick={() => goTo(offset + PAGE_SIZE)}
          >
            Next
          </Button>
          <Button variant="outline" size="sm" onClick={closeAndReset}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
