"use client"

/**
 * Read-only detail panel: everything inwarded against one PO.
 *
 * Reconciliation first — Ordered / Received / Open sit above the list, because the
 * question this panel answers is "does what arrived add up, and is anything missing
 * a document". Invoice lines follow, newest invoice first.
 *
 * The "Received without an invoice" row is derived by subtraction server-side, so it
 * carries no date and always renders last, after the dated lines. See the route's
 * header comment for why manual receipts cannot be listed per-event.
 *
 * Visual language follows app/masters/bom-master/BomDetailPanel.tsx.
 */

import { X, Paperclip, Loader2, History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { STATUS_CONFIG, type InwardingResponse } from "./po-types"

function fmtDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function fmtQty(v: string | number | null | undefined) {
  return Number(v ?? 0).toLocaleString("en-IN")
}

function fmtMoney(v: string | number | null | undefined) {
  if (v == null) return null
  return `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}

async function viewInvoice(s3Key: string) {
  try {
    const res = await fetch(`/api/files/presign?key=${encodeURIComponent(s3Key)}&view=1`)
    const data = await res.json()
    if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
  } catch {
    window.alert("Could not open the invoice")
  }
}

/** Ordered / Received / Open. Open is clamped at 0 — an over-receipt inside
 *  tolerance would otherwise render as a negative outstanding. */
function Reconciliation({ qty, received }: { qty: number; received: number }) {
  const open = Math.max(0, qty - received)
  const cells = [
    { label: "Ordered", value: qty, tone: "text-foreground" },
    { label: "Received", value: received, tone: "text-emerald-700 dark:text-emerald-400" },
    { label: "Open", value: open, tone: open > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground" },
  ]
  return (
    <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      {cells.map((c) => (
        <div key={c.label}>
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {c.label}
          </div>
          <div className={cn("mt-0.5 text-base font-semibold tabular-nums leading-none", c.tone)}>
            {fmtQty(c.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function InwardingPanel({
  detail,
  loading,
  error,
  onClose,
  onRetry,
  onOpenHistory,
}: {
  detail: InwardingResponse | null
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
  onOpenHistory: () => void
}) {
  const status = detail?.po.status ? STATUS_CONFIG[detail.po.status] : null

  return (
    <Card className="max-h-[calc(100vh-3rem)] flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-heading text-base">Inwarding</CardTitle>
            {detail && (
              <>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">{detail.po.po_no}</span>
                  {status && (
                    <Badge variant={status.variant} className="text-[10px]">{status.label}</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {detail.po.mfg_code} · {detail.po.mfg_name}
                </p>
              </>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close inwarding panel">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-y-auto space-y-3">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading inwarding…
          </div>
        )}

        {error && !loading && (
          <div className="space-y-2 py-4">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
          </div>
        )}

        {detail && !loading && !error && (
          <>
            <Reconciliation
              qty={Number(detail.po.qty ?? 0)}
              received={Number(detail.po.received_qty ?? 0)}
            />

            {detail.lines.length === 0 && detail.withoutInvoice === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Nothing inwarded yet. Receipts booked against this order will appear here.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {detail.lines.map((l) => (
                  <div key={`${l.invoice_id}-${l.line_no}`} className="py-2.5 first:pt-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-1.5">
                        <span className="font-mono text-xs font-medium">{l.invoice_no}</span>
                        {l.link_type === "created" && (
                          <Badge variant="secondary" className="text-[10px]">raised this PO</Badge>
                        )}
                      </div>
                      <span className="text-sm font-semibold tabular-nums shrink-0">
                        {fmtQty(l.line_qty)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {[
                          fmtDate(l.invoice_date),
                          l.batch && `batch ${l.batch}`,
                          l.expiry && `exp ${l.expiry}`,
                          fmtMoney(l.line_total),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {l.attachment_key && (
                        <button
                          type="button"
                          onClick={() => viewInvoice(l.attachment_key!)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Open invoice ${l.invoice_no}`}
                          title="Open invoice PDF"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {detail.withoutInvoice > 0 && (
                  <div className="py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium">Received without an invoice</span>
                      <span className="text-sm font-semibold tabular-nums shrink-0">
                        {fmtQty(detail.withoutInvoice)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Booked at the desk — no document on file
                    </p>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={onOpenHistory}
              className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <History className="h-3.5 w-3.5" />
              Full receipt log
            </button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
