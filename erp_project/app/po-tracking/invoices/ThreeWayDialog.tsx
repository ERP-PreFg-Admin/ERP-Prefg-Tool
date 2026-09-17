"use client"

// The three-way drilldown. Each leg card opens what it is a claim about — the
// purchase orders, the goods receipts, the invoice document — and carries the
// sign-off that is the only way that leg turns green.
//
// Fetches the invoice detail itself rather than borrowing the table's expansion
// cache: it opens from a row that may never have been expanded.

import { useCallback, useEffect, useState } from "react"
import { Check, CreditCard, ExternalLink, FileText, Loader2, Package, RotateCw, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { Leg, ThreeWayMatch } from "@/lib/invoice/three-way"
import { threeWayMatch } from "@/lib/invoice/three-way"
import type { InvoiceDocument, InvoiceGrnLine, InvoiceHistoryHeader, InvoiceHistoryItem, InvoiceLegVerification } from "@/types/invoice"
import { IST } from "@/lib/date"
import { parseVerifiedLegs } from "./ThreeWayCells"

type LegKey = "po" | "pod" | "inv"

const num = (v: unknown) => (v == null || v === "" ? null : Number(v))
const qty = (v: unknown) => {
  const n = num(v)
  return n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 3 })
}
const money = (v: unknown) => {
  const n = num(v)
  return n == null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}
const shortDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: IST }) : null

const ICON = { po: FileText, pod: Package, inv: CreditCard }

const TONE = {
  ok:         "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400",
  unverified: "border-dashed border-border bg-background text-foreground/70",
  variance:   "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400",
  missing:    "border-border bg-muted text-muted-foreground",
}

function LegCard({
  kind, title, blurb, leg, refs, lines, open, onOpen, signature, onVerify, saving,
}: {
  kind: LegKey
  title: string
  blurb: string
  leg: Leg
  refs: string[]
  lines: [string, string][]
  open: boolean
  onOpen: () => void
  signature?: InvoiceLegVerification
  onVerify: (verified: boolean) => void
  saving: boolean
}) {
  const Icon = ICON[kind]
  const absent = leg.state === "missing"
  return (
    <div className={cn(
      "rounded-lg border p-4 text-left transition-colors",
      open ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      absent ? "bg-muted/30" : "bg-background"
    )}>
      {/* The card body opens the entries below; the verify button is its own
          control so signing off can never be a mis-click on "show me". */}
      <button onClick={onOpen} className="w-full text-left focus-visible:outline-none">
        <div className="mb-3 flex items-start justify-between">
          <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-md border", TONE[leg.state])}>
            <Icon className="h-4 w-4" />
          </span>
          {absent
            ? <X className="h-4 w-4 text-muted-foreground" />
            : leg.verified
            ? <Check className={cn("h-4 w-4", leg.state === "variance" ? "text-amber-600" : "text-emerald-600")} />
            : <span className="text-[10px] uppercase tracking-wide text-muted-foreground">unverified</span>}
        </div>

        <h3 className={cn("text-sm font-semibold", absent && "text-muted-foreground")}>{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{blurb}</p>

        {refs.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">Awaiting</p>
        ) : (
          <div className="mt-4 space-y-1 text-xs">
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {refs.slice(0, 3).map((r) => <span key={r} className="font-mono">{r}</span>)}
              {refs.length > 3 && <span className="text-muted-foreground">+{refs.length - 3} more</span>}
            </div>
            {lines.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 tabular-nums">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
        )}

        {leg.note && (
          <p className={cn(
            "mt-3 text-[11px] leading-snug",
            leg.state === "variance" ? "text-destructive" : "text-muted-foreground"
          )}>
            {leg.note}
          </p>
        )}
      </button>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        <button
          onClick={onOpen}
          className="text-[11px] text-primary underline-offset-2 hover:underline"
        >
          {open ? "Hide entries" : "Open entries"}
        </button>
        <Button
          size="xs"
          variant={leg.verified ? "outline" : "default"}
          disabled={absent || saving}
          onClick={() => onVerify(!leg.verified)}
          // Never "mark matched": the button records that a person looked at the
          // document, which is a different claim from the numbers agreeing.
          title={absent
            ? "Nothing on file to verify"
            : leg.verified
            ? "Withdraw this sign-off"
            : "Confirm you have physically checked this document"}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : leg.verified ? "Verified" : "Mark verified"}
        </Button>
      </div>

      {signature && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {signature.verified_by_name ?? `User ${signature.verified_by}`} · {shortDate(signature.verified_at)}
          {signature.remarks ? ` · ${signature.remarks}` : ""}
        </p>
      )}
    </div>
  )
}

export default function ThreeWayDialog({
  invoice, onClose, onChanged,
}: {
  /** Null closes the dialog — the parent holds which row is open. */
  invoice: InvoiceHistoryHeader | null
  onClose: () => void
  /** Fired after a sign-off so the list picks up the new badge. */
  onChanged?: () => void
}) {
  const [items, setItems] = useState<InvoiceHistoryItem[]>([])
  const [grns, setGrns]   = useState<InvoiceGrnLine[]>([])
  const [documents, setDocuments] = useState<InvoiceDocument[]>([])
  const [verifications, setVerifications] = useState<InvoiceLegVerification[]>([])
  // Starts true: the parent keys this component on the invoice id, so a mount
  // always means a fetch. Raising it inside the effect would be a synchronous
  // setState during render.
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState("")
  const [openLeg, setOpenLeg] = useState<LegKey | null>(null)
  const [saving, setSaving]   = useState<LegKey | null>(null)
  const [fetchingDocs, setFetchingDocs] = useState(false)
  const [docNote, setDocNote] = useState("")

  const id = invoice?.id ?? null

  useEffect(() => {
    if (id == null) return
    let cancelled = false
    fetch(`/api/v1/purchase-orders/invoice/${id}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? "Couldn't load this invoice.")
        return data as {
          items?: InvoiceHistoryItem[]; grns?: InvoiceGrnLine[]
          documents?: InvoiceDocument[]; verifications?: InvoiceLegVerification[]
        }
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? []); setGrns(d.grns ?? [])
        setDocuments(d.documents ?? []); setVerifications(d.verifications ?? [])
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this invoice.") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  /** Open a stored PDF through a short-lived presigned URL. */
  const openKey = useCallback(async (key: string) => {
    // Opened synchronously — a popup blocker kills window.open() after an await.
    const tab = window.open("", "_blank")
    try {
      const res = await fetch(`/api/v1/files/presign?key=${encodeURIComponent(key)}&expiresIn=3600`)
      const data = await res.json().catch(() => ({}))
      if (data.url && tab) tab.location.href = data.url
      else { tab?.close(); setError("Couldn't open that document.") }
    } catch {
      tab?.close(); setError("Couldn't open that document.")
    }
  }, [])

  /** Pull this one invoice's documents from its Uniware PO. */
  async function fetchDocs() {
    if (id == null) return
    setFetchingDocs(true)
    setDocNote("")
    setError("")
    try {
      const res = await fetch(`/api/v1/purchase-orders/invoice/${id}/documents`, { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Couldn't reach Uniware.")
      setDocuments(data.documents ?? [])
      // "Nothing new" and "it worked" look identical otherwise, and the desk
      // needs to know which so it knows whether to chase the warehouse.
      setDocNote(data.pulled > 0
        ? `Pulled ${data.pulled} document${data.pulled === 1 ? "" : "s"}.`
        : "Nothing new on the Uniware PO.")
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't reach Uniware.")
    } finally {
      setFetchingDocs(false)
    }
  }

  async function verify(leg: LegKey, verified: boolean) {
    if (id == null) return
    setSaving(leg)
    setError("")
    try {
      const res = await fetch(`/api/v1/purchase-orders/invoice/${id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leg, verified }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Couldn't record that.")
      setVerifications(data.verifications ?? [])
      onChanged?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't record that.")
    } finally {
      setSaving(null)
    }
  }

  if (!invoice) return null

  // Re-derived from the LIVE verifications, not from the row that opened the
  // dialog — otherwise the cards keep showing the state from before the click.
  const verifiedNow = {
    po:  verifications.some((v) => v.leg === "po"),
    pod: verifications.some((v) => v.leg === "pod"),
    inv: verifications.some((v) => v.leg === "inv"),
  }
  const match: ThreeWayMatch = threeWayMatch({
    billedQty:       invoice.billed_qty        ?? 0,
    poCount:         invoice.po_count          ?? 0,
    poUnlinkedLines: invoice.po_unlinked_lines ?? 0,
    itemCount:       invoice.item_count        ?? 0,
    linesValue:      invoice.lines_value       ?? 0,
    invoiceTotal:    invoice.invoice_total     ?? 0,
    grnCount:        invoice.grn_count         ?? 0,
    grnAccepted:     invoice.grn_accepted      ?? 0,
    grnRejected:     invoice.grn_rejected      ?? 0,
    // Before the fetch lands, fall back to what the row already said.
    verified: loading ? parseVerifiedLegs(invoice.verified_legs) : verifiedNow,
  })

  const poLines = items.filter((i) => i.received_against_po_no)
  const poRefs  = [...new Map(poLines.map((i) => [i.received_against_po_no!, i])).values()]
  const orderedQty = poRefs.reduce((t, i) => t + Number(i.received_against_qty ?? 0), 0)

  // Split by which side attached it. 'uniware' is what the WAREHOUSE put on the
  // PO — the signed & stamped copy above all — which is evidence of delivery, so
  // it belongs to the GRN leg. 'erp' is our own invoice PDF pushed up, which is
  // the same document the INV leg already has.
  const signedCopies = documents.filter((d) => d.source === "uniware")
  const ourCopies    = documents.filter((d) => d.source === "erp")

  const grnRefs  = [...new Set(grns.map((g) => g.grn_code))]
  const accepted = grns.reduce((t, g) => t + Number(g.quantity ?? 0), 0)
  const rejected = grns.reduce((t, g) => t + Number(g.rejected_qty ?? 0), 0)
  const lastGrn  = grns.map((g) => g.grn_created_at).filter(Boolean).sort().at(-1) ?? null

  const linesValue  = num(invoice.lines_value)
  const total       = num(invoice.invoice_total)
  const outstanding = [match.po, match.pod, match.inv].filter((l) => l.state === "missing").length
  const unsigned    = [match.po, match.pod, match.inv].filter((l) => l.state === "unverified").length
  const sig = (leg: LegKey) => verifications.find((v) => v.leg === leg)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Three-way match · {invoice.invoice_no}</DialogTitle>
          <DialogDescription>
            {invoice.mfg_name} · {invoice.item_count ?? 0} line{(invoice.item_count ?? 0) === 1 ? "" : "s"}
            {invoice.destination ? ` · ${invoice.destination}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant={
            match.badge === "fully_matched" ? "success"
            : match.badge === "variance" ? "warning"
            : match.badge === "invoice_matched" ? "info"
            : match.badge === "awaiting_verification" ? "outline"
            : "secondary"
          }>
            {match.label}
          </Badge>
          <span className="text-xs tabular-nums text-muted-foreground">
            {match.onFile}/3 on file · {match.verifiedCount}/3 verified
          </span>
        </div>

        {error ? (
          <Callout variant="destructive">{error}</Callout>
        ) : outstanding > 0 ? (
          <Callout variant="info">
            {outstanding} document{outstanding === 1 ? "" : "s"} still outstanding before this reconciles.
          </Callout>
        ) : match.badge === "variance" ? (
          <Callout variant="warning">All three documents are on file, but they disagree.</Callout>
        ) : unsigned > 0 ? (
          <Callout variant="info">
            The numbers agree. {unsigned} leg{unsigned === 1 ? "" : "s"} still need someone to confirm
            they have physically checked the document.
          </Callout>
        ) : (
          <Callout variant="success">All three agree within tolerance and are physically verified.</Callout>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <LegCard
                kind="po" title="Purchase order" leg={match.po}
                blurb="Authorises the buy — agreed price, quantity, item."
                refs={poRefs.map((i) => i.received_against_po_no!)}
                lines={[["Ordered", `${qty(orderedQty)} pcs`]]}
                open={openLeg === "po"} onOpen={() => setOpenLeg(openLeg === "po" ? null : "po")}
                signature={sig("po")} saving={saving === "po"}
                onVerify={(v) => void verify("po", v)}
              />
              <LegCard
                kind="inv" title="Supplier invoice" leg={match.inv}
                blurb="Final amount owed for delivered goods."
                refs={[invoice.invoice_no]}
                lines={[
                  ["Billed", `${qty(invoice.billed_qty)} pcs`],
                  ["Header", money(total)],
                  // Only when it disagrees — the same number twice is noise.
                  ...(linesValue != null && total != null && Math.abs(linesValue - total) > 1
                    ? [["Lines", money(linesValue)] as [string, string]]
                    : []),
                ]}
                open={openLeg === "inv"} onOpen={() => setOpenLeg(openLeg === "inv" ? null : "inv")}
                signature={sig("inv")} saving={saving === "inv"}
                onVerify={(v) => void verify("inv", v)}
              />
              <LegCard
                kind="pod" title="GRN" leg={match.pod}
                blurb="Goods receipt at site, with the signed &amp; stamped copy."
                refs={grnRefs}
                lines={[
                  ["Accepted", `${qty(accepted)} pcs`],
                  ...(rejected > 0 ? [["Rejected", `${qty(rejected)} pcs`] as [string, string]] : []),
                  ...(lastGrn ? [["Received", shortDate(lastGrn) ?? "—"] as [string, string]] : []),
                  ...(signedCopies.length > 0
                    ? [["Signed copy", `${signedCopies.length}`] as [string, string]]
                    : []),
                ]}
                open={openLeg === "pod"} onOpen={() => setOpenLeg(openLeg === "pod" ? null : "pod")}
                signature={sig("pod")} saving={saving === "pod"}
                onVerify={(v) => void verify("pod", v)}
              />
            </div>

            {openLeg && (
              <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
                {openLeg === "po" && (
                  poRefs.length === 0
                    ? <p className="text-xs text-muted-foreground">No purchase order is linked to these lines.</p>
                    : <table className="w-full text-[11px]">
                        <thead>
                          <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                            <th>Purchase order</th><th>SKU</th>
                            <th className="text-right">Ordered</th>
                            <th className="text-right">Received</th>
                            <th className="text-right">Billed here</th>
                            {/* Invoice-side money only. The order's own rate is
                                NULL on every procurement PO — see the note in
                                selectItemsByInvoiceId. */}
                            <th className="text-right">Rate</th>
                            <th className="text-right">Billed ₹</th>
                            <th className="w-16" />
                          </tr>
                        </thead>
                        <tbody>
                          {poRefs.map((i) => {
                            const onPo = poLines.filter((l) => l.received_against_po_no === i.received_against_po_no)
                            const billedOnPo = onPo.reduce((t, l) => t + Number(l.qty ?? 0), 0)
                            const billedValue = onPo.reduce((t, l) => t + Number(l.total_amount ?? 0), 0)
                            return (
                              <tr key={i.received_against_po_no} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
                                <td className="font-mono">{i.received_against_po_no}</td>
                                <td>{i.sku_code ?? "—"}</td>
                                <td className="text-right tabular-nums">{qty(i.received_against_qty)}</td>
                                <td className="text-right tabular-nums">{qty(i.received_against_received_qty)}</td>
                                <td className="text-right tabular-nums">{qty(billedOnPo)}</td>
                                <td className="text-right tabular-nums">{money(i.rate)}</td>
                                <td className="text-right tabular-nums">{money(billedValue)}</td>
                                <td>
                                  {/* Opens PO Tracking filtered to that order — there
                                      is no single-PO page to link to. */}
                                  <a
                                    href={`/po-tracking/po-procurement?search=${encodeURIComponent(i.received_against_po_no!)}`}
                                    target="_blank" rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                                  >
                                    Open <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                )}

                {openLeg === "pod" && (
                  <div className="space-y-3">
                    {/* The signed copy sits with the GRN, not the invoice: it is
                        the warehouse's acknowledgement that the goods landed. */}
                    <div className="flex flex-wrap items-center gap-2">
                      {signedCopies.map((d) => (
                        <Button key={d.id} size="xs" variant="outline" onClick={() => void openKey(d.s3_key)}>
                          <FileText className="h-3 w-3" />
                          <span className="max-w-48 truncate" title={d.filename}>{d.filename}</span>
                          {d.uniware_uploaded_by && (
                            <span className="max-w-28 truncate text-muted-foreground">{d.uniware_uploaded_by}</span>
                          )}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </Button>
                      ))}
                      {/* Asks Uniware about THIS invoice only. The toolbar's
                          button sweeps 40, which is 40 mints for one answer. */}
                      <Button size="xs" variant="ghost" disabled={fetchingDocs} onClick={() => void fetchDocs()}>
                        {fetchingDocs
                          ? <><Loader2 className="h-3 w-3 animate-spin" /> Fetching…</>
                          : <><RotateCw className="h-3 w-3" /> {signedCopies.length ? "Re-fetch" : "Fetch signed copy"}</>}
                      </Button>
                      {docNote && <span className="text-[11px] text-muted-foreground">{docNote}</span>}
                    </div>
                    {signedCopies.length === 0 && !docNote && (
                      <p className="text-xs text-muted-foreground">
                        No signed copy held for this invoice yet.
                      </p>
                    )}

                    {grns.length === 0
                    ? <p className="text-xs text-muted-foreground">No goods receipt synced against this invoice yet.</p>
                    : <table className="w-full text-[11px]">
                        <thead>
                          <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                            <th>GRN</th><th>SKU</th><th>Inward PO</th><th>Batch</th><th>Received</th>
                            <th className="text-right">Accepted</th><th className="text-right">Rejected</th>
                            <th className="text-right">Rate</th>
                            <th className="text-right">Accepted ₹</th>
                            <th className="text-right">Rejected ₹</th>
                          </tr>
                        </thead>
                        <tbody>
                          {grns.map((g) => (
                            <tr key={`${g.grn_code}-${g.line_no}`} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
                              <td className="font-mono">{g.grn_code}</td>
                              <td>{g.sku_code ?? "—"}</td>
                              {/* No PO is a finding, not a blank: the site received
                                  a SKU we never raised an order for. */}
                              <td className="font-mono">
                                {g.po_no ?? <span className="text-amber-700 dark:text-amber-400">unmatched</span>}
                              </td>
                              <td>{g.batch_code ?? "—"}</td>
                              <td>{shortDate(g.grn_created_at) ?? "—"}</td>
                              <td className="text-right tabular-nums">{qty(g.quantity)}</td>
                              <td className={cn(
                                "text-right tabular-nums",
                                Number(g.rejected_qty ?? 0) > 0 && "font-medium text-amber-700 dark:text-amber-400"
                              )}>
                                {qty(g.rejected_qty)}
                              </td>
                              {/* A dash, never ₹0 — an unpriced line is unknown
                                  value, not a costless rejection. */}
                              <td className="text-right tabular-nums text-muted-foreground">
                                {g.po_unit_price == null ? "—" : money(g.po_unit_price)}
                              </td>
                              <td className="text-right tabular-nums">
                                {g.po_unit_price == null ? "—" : money(Number(g.quantity ?? 0) * Number(g.po_unit_price))}
                              </td>
                              <td className={cn("text-right tabular-nums",
                                Number(g.rejected_qty ?? 0) > 0 && g.po_unit_price != null &&
                                  "font-medium text-amber-700 dark:text-amber-400")}>
                                {g.po_unit_price == null ? "—" : money(Number(g.rejected_qty ?? 0) * Number(g.po_unit_price))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    }
                  </div>
                )}

                {openLeg === "inv" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {invoice.attachment_key && (
                        <Button size="xs" variant="outline" onClick={() => void openKey(invoice.attachment_key!)}>
                          <FileText className="h-3 w-3" /> Original invoice <ExternalLink className="h-2.5 w-2.5" />
                        </Button>
                      )}
                      {/* Only our own pushed copy here — what the warehouse
                          attached is evidence of delivery and lives on GRN. */}
                      {ourCopies.map((d) => (
                        <Button key={d.id} size="xs" variant="outline" onClick={() => void openKey(d.s3_key)}>
                          <FileText className="h-3 w-3" />
                          <span className="max-w-40 truncate" title={d.filename}>{d.filename}</span>
                          <span className="text-muted-foreground">pushed</span>
                          <ExternalLink className="h-2.5 w-2.5" />
                        </Button>
                      ))}
                      {!invoice.attachment_key && ourCopies.length === 0 && (
                        <p className="text-xs text-muted-foreground">No invoice document stored.</p>
                      )}
                    </div>
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                          <th className="w-8">#</th><th>SKU</th><th>Product</th>
                          <th className="text-right">Qty</th><th className="text-right">Rate</th>
                          <th className="text-right">Line total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((li) => (
                          <tr key={li.id} className="border-t border-border/60 [&>td]:px-1.5 [&>td]:py-1">
                            <td className="text-muted-foreground">{li.line_no}</td>
                            <td className="font-medium">{li.sku_code ?? "—"}</td>
                            <td className="max-w-56 truncate" title={li.sku_name ?? ""}>{li.sku_name ?? "—"}</td>
                            <td className="text-right tabular-nums">{qty(li.qty)}</td>
                            <td className="text-right tabular-nums">{money(li.rate)}</td>
                            <td className="text-right tabular-nums">{money(li.total_amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* The PO leg carries no per-invoice ordered figure, so say which orders
            the number came from rather than letting it look like this invoice's. */}
        {poRefs.length > 1 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Ordered totals {poRefs.length} purchase orders these lines settled; each may also be
            settled by other invoices.
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild><Button variant="outline" size="sm">Close</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
