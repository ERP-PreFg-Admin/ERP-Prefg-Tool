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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { Leg, LegVerification, ThreeWayMatch } from "@/lib/invoice/three-way"
import { grnTotals, grnTotalsBySku, gstRateLabel, lineTotals, lineTotalsBySku, threeWayBySku, threeWayMatch } from "@/lib/invoice/three-way"
import type { InvoiceDocument, InvoiceGrnLine, InvoiceHistoryHeader, InvoiceHistoryItem, InvoiceLegVerification } from "@/types/invoice"
import { IST } from "@/lib/date"
import { parseVerifiedLegs } from "./ThreeWayCells"
import SkuSummary from "./SkuSummary"

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
  kind, title, blurb, leg, refs, lines, open, onOpen, signature, onVerify, saving, dirty,
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
  onVerify: () => void
  saving: boolean
  /** Staged but not yet written. */
  dirty: boolean
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
          onClick={onVerify}
          // Never "mark matched": the button records that a person looked at the
          // document, which is a different claim from the numbers agreeing.
          title={absent
            ? "Nothing on file to verify"
            : leg.verified
            ? "Withdraw this sign-off — takes effect on Save"
            : "Confirm you have physically checked this document — takes effect on Save"}
        >
          {leg.verified ? "Verified" : "Mark verified"}
        </Button>
      </div>

      {dirty && (
        <p className="mt-2 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          Unsaved — {leg.verified ? "will be signed off" : "sign-off will be withdrawn"} on Save
        </p>
      )}
      {signature && !dirty && (
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
  const [saving, setSaving]   = useState(false)
  /** Staged sign-offs. Seeded from the server on load; written only on Save. */
  const [draft, setDraft]     = useState<LegVerification>({ po: false, pod: false, inv: false })
  const [fetchingDocs, setFetchingDocs] = useState(false)
  const [docNote, setDocNote] = useState("")
  const [askClose, setAskClose] = useState(false)
  /** sku_code → the SKU's current Agreed Final Costing rate. */
  const [agreedRates, setAgreedRates] = useState<Record<string, number>>({})

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
          agreedRates?: Record<string, number>
        }
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? []); setGrns(d.grns ?? [])
        setDocuments(d.documents ?? [])
        setAgreedRates(d.agreedRates ?? {})
        const v = d.verifications ?? []
        setVerifications(v)
        setDraft({
          po:  v.some((x) => x.leg === "po"),
          pod: v.some((x) => x.leg === "pod"),
          inv: v.some((x) => x.leg === "inv"),
        })
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

  /**
   * Stage a sign-off. Nothing is written until Save.
   *
   * A signature is a claim that a person checked a document, so it should take a
   * deliberate act — not a click that lands the moment the pointer does, with no
   * chance to reconsider after opening the PDF beside it.
   */
  function toggleDraft(leg: LegKey) {
    setDraft((d) => ({ ...d, [leg]: !d[leg] }))
  }

  /** Write every staged change. One call per leg — the route is per leg. */
  async function saveVerifications() {
    if (id == null || dirtyLegs.length === 0) return
    setSaving(true)
    setError("")
    try {
      // Sequential, not parallel: three requests at most, and a failure part way
      // through should leave the earlier ones written rather than racing.
      let latest: InvoiceLegVerification[] = verifications
      for (const leg of dirtyLegs) {
        const res = await fetch(`/api/v1/purchase-orders/invoice/${id}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leg, verified: draft[leg] }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? "Couldn't record that.")
        latest = data.verifications ?? latest
      }
      setVerifications(latest)
      onChanged?.()
    } catch (e: unknown) {
      // The draft is kept, so a failed save can be retried without re-ticking.
      setError(e instanceof Error ? e.message : "Couldn't record that.")
    } finally {
      setSaving(false)
    }
  }

  /** Closing with staged sign-offs asks first — they are cheap to redo but easy
   *  to lose, and losing one silently is worse than one extra click. */
  function requestClose() {
    if (dirtyLegs.length > 0) { setAskClose(true); return }
    onClose()
  }

  if (!invoice) return null

  // Re-derived from the LIVE verifications, not from the row that opened the
  // dialog — otherwise the cards keep showing the state from before the click.
  const savedLegs = {
    po:  verifications.some((v) => v.leg === "po"),
    pod: verifications.some((v) => v.leg === "pod"),
    inv: verifications.some((v) => v.leg === "inv"),
  }
  // What Save would produce, so the cards and the badge preview the change
  // rather than describing a state the desk has already moved on from.
  const dirtyLegs = (["po", "inv", "pod"] as const).filter((k) => draft[k] !== savedLegs[k])
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
    verified: loading ? parseVerifiedLegs(invoice.verified_legs) : draft,
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

  const totals      = lineTotals(items)
  const grnAll      = grnTotals(grns)
  const poTotals    = lineTotals(poLines)
  /**
   * One row per SKU with all three rates.
   *
   * The invoice rate is taxable / qty — a weighted average, because one SKU can
   * sit on two lines at two rates and picking either would misreport the other.
   * The PO rate is the order's, taken from the first line that carries one.
   */
  const rateRows = lineTotalsBySku(items).map((sk) => {
    const poRate = num(items.find((i) => (i.sku_code ?? "—") === sk.sku
      && i.received_against_unit_price != null)?.received_against_unit_price ?? null)
    const invRate = sk.qty > 0 ? sk.taxable / sk.qty : null
    const agreed = agreedRates[sk.sku] ?? null
    return {
      sku: sk.sku, poRate, invRate, agreed,
      delta: invRate != null && agreed != null ? invRate - agreed : null,
    }
  })

  const linesValue  = num(invoice.lines_value)
  const total       = num(invoice.invoice_total)
  const outstanding = [match.po, match.pod, match.inv].filter((l) => l.state === "missing").length
  const unsigned    = [match.po, match.pod, match.inv].filter((l) => l.state === "unverified").length
  const sig = (leg: LegKey) => verifications.find((v) => v.leg === leg)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) requestClose() }}>
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

        {askClose ? (
          <Callout variant="warning">
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {dirtyLegs.length} sign-off{dirtyLegs.length === 1 ? "" : "s"} staged but not saved.
              </span>
              <Button size="xs" className="ml-auto" disabled={saving}
                onClick={() => { setAskClose(false); void saveVerifications().then(onClose) }}>
                Save and close
              </Button>
              <Button size="xs" variant="outline" onClick={() => { setDraft(savedLegs); setAskClose(false); onClose() }}>
                Discard
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setAskClose(false)}>Keep editing</Button>
            </div>
          </Callout>
        ) : error ? (
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
                signature={sig("po")} saving={saving}
                dirty={dirtyLegs.includes("po")}
                onVerify={() => toggleDraft("po")}
              />
              <LegCard
                kind="inv" title="Supplier invoice" leg={match.inv}
                blurb="Final amount owed for delivered goods."
                refs={[invoice.invoice_no]}
                lines={[
                  ["Billed", `${qty(invoice.billed_qty)} pcs`],
                  ["Header", money(total)],
                  ["Documents", `${(invoice.attachment_key ? 1 : 0) + documents.length}`],
                  // Only when it disagrees — the same number twice is noise.
                  ...(linesValue != null && total != null && Math.abs(linesValue - total) > 1
                    ? [["Lines", money(linesValue)] as [string, string]]
                    : []),
                ]}
                open={openLeg === "inv"} onOpen={() => setOpenLeg(openLeg === "inv" ? null : "inv")}
                signature={sig("inv")} saving={saving}
                dirty={dirtyLegs.includes("inv")}
                onVerify={() => toggleDraft("inv")}
              />
              <LegCard
                kind="pod" title="GRN" leg={match.pod}
                blurb="Goods receipt at site — what actually arrived."
                refs={grnRefs}
                lines={[
                  ["QC passed", `${qty(accepted)} pcs`],
                  ...(rejected > 0 ? [["Rejected", `${qty(rejected)} pcs`] as [string, string]] : []),
                  ...(lastGrn ? [["Received", shortDate(lastGrn) ?? "—"] as [string, string]] : []),
                ]}
                open={openLeg === "pod"} onOpen={() => setOpenLeg(openLeg === "pod" ? null : "pod")}
                signature={sig("pod")} saving={saving}
                dirty={dirtyLegs.includes("pod")}
                onVerify={() => toggleDraft("pod")}
              />
            </div>

            {!openLeg && items.length + grns.length > 0 && (
              <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
                {/* The only place billed and accepted meet at SKU grain: the
                    invoice panel knows what was charged, the GRN panel knows
                    what arrived, and "which SKU is short" needs both. Shown
                    until a leg is opened, which then takes this space. */}
                <SkuSummary
                  title="All three legs, by SKU"
                  head={["SKU", "Billed", "Taxable", "GST", "Payable", "QC passed", "Rejected", "Short"]}
                  note="open a card above for that leg in full"
                  foot={[
                    `Total · ${threeWayBySku(items, grns).length} SKUs`,
                    qty(totals.qty), money(totals.taxable),
                    <span key="x">{money(totals.gst)}
                      <span className="ml-1 font-normal text-muted-foreground">{gstRateLabel(totals.gstRate)}</span>
                    </span>,
                    <span key="v" className="font-semibold">{money(totals.gross)}</span>,
                    qty(grnAll.accepted),
                    grnAll.rejected > 0
                      ? <span key="r" className="text-amber-700 dark:text-amber-400">{qty(grnAll.rejected)}</span>
                      : qty(grnAll.rejected),
                    // The invoice-level gap, so the column foots to the same
                    // number the GRN leg reports rather than a re-derived one.
                    match.pod.state === "missing"
                      ? <span key="s" className="text-muted-foreground">awaiting</span>
                      : <span key="s" className={cn(
                          Math.max(0, totals.qty - grnAll.accepted - grnAll.rejected) > 0 &&
                            "text-amber-700 dark:text-amber-400")}>
                          {qty(Math.max(0, totals.qty - grnAll.accepted - grnAll.rejected))}
                        </span>,
                  ]}
                  rows={threeWayBySku(items, grns).map((k) => [
                    k.unbilled
                      ? <span key="s" className="text-amber-700 dark:text-amber-400" title="Received against no invoice line">
                          {k.sku} · unbilled
                        </span>
                      : k.sku,
                    qty(k.billedQty),
                    k.unbilled ? <span key="t" className="text-muted-foreground">—</span> : money(k.taxable),
                    k.unbilled
                      ? <span key="x" className="text-muted-foreground">—</span>
                      : <span key="x">{money(k.gst)}
                          <span className="ml-1 text-muted-foreground">{gstRateLabel(k.gstRate)}</span>
                        </span>,
                    k.unbilled
                      ? <span key="v" className="text-muted-foreground">—</span>
                      : <span key="v" className="font-medium">{money(k.gross)}</span>,
                    k.noReceipt ? <span key="a" className="text-muted-foreground">—</span> : qty(k.accepted),
                    k.rejected > 0
                      ? <span key="r" className="font-medium text-amber-700 dark:text-amber-400">{qty(k.rejected)}</span>
                      : qty(k.rejected),
                    k.noReceipt
                      ? <span key="g" className="text-muted-foreground">awaiting</span>
                      : k.awaited > 0
                      ? <span key="g" className="font-medium text-amber-700 dark:text-amber-400">{qty(k.awaited)}</span>
                      : k.overReceipt > 0
                      ? <span key="g" className="font-medium text-amber-700 dark:text-amber-400">+{qty(k.overReceipt)} over</span>
                      : <span key="g" className="text-muted-foreground">0</span>,
                  ])}
                />

                {/* Three claims about one unit price: what the order agreed,
                    what the invoice charged, and what the SKU costs today under
                    Agreed Final Costing. The last is live — it moves when
                    material rates do — so a gap is not necessarily an error. */}
                <div className="mt-3">
                  <SkuSummary
                    title="Rates by SKU"
                    head={["SKU", "PO rate", "Invoice rate", "Current agreed rate", "Inv vs agreed"]}
                    note="agreed rate is today's Final Costing, not the rate at invoice date"
                    rows={rateRows.map((r) => [
                      r.sku,
                      r.poRate == null ? <span key="p" className="text-muted-foreground">—</span> : money(r.poRate),
                      r.invRate == null ? <span key="i" className="text-muted-foreground">—</span> : money(r.invRate),
                      r.agreed == null
                        ? <span key="a" className="text-muted-foreground" title="No live production line or no costing for this SKU">no costing</span>
                        : money(r.agreed),
                      r.delta == null
                        ? <span key="d" className="text-muted-foreground">—</span>
                        : <span key="d" className={cn(Math.abs(r.delta) > 0.005 && "font-medium text-amber-700 dark:text-amber-400")}>
                            {r.delta > 0 ? "+" : ""}{money(r.delta)}
                          </span>,
                    ])}
                  />
                </div>
              </div>
            )}

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
                        <tfoot className="border-t-2 border-border">
                          <tr className="[&>td]:px-1.5 [&>td]:py-1 [&>td]:font-medium">
                            <td colSpan={2} className="text-muted-foreground">
                              Total · {poRefs.length} order{poRefs.length === 1 ? "" : "s"}
                            </td>
                            <td className="text-right tabular-nums">{qty(orderedQty)}</td>
                            <td className="text-right tabular-nums">
                              {qty(poRefs.reduce((t, i) => t + Number(i.received_against_received_qty ?? 0), 0))}
                            </td>
                            <td className="text-right tabular-nums">{qty(poTotals.qty)}</td>
                            <td />
                            <td className="text-right tabular-nums">{money(poTotals.taxable)}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                )}

                {openLeg === "po" && poLines.length > 0 && (
                  <div className="mt-3">
                    {/* Per SKU rather than per order: one SKU can settle two
                        orders, and "how much of this did we buy" is the question
                        the order list cannot answer. */}
                    <SkuSummary
                      title="By SKU"
                      head={["SKU", "Billed qty", "Taxable", "GST", "Payable", "Lines"]}
                      rows={lineTotalsBySku(poLines).map((sk) => [
                        sk.sku, qty(sk.qty), money(sk.taxable),
                        <span key="x">{money(sk.gst)}
                          <span className="ml-1 text-muted-foreground">{gstRateLabel(sk.gstRate)}</span>
                        </span>,
                        <span key="g" className="font-medium">{money(sk.gross)}</span>,
                        sk.lines,
                      ])}
                    />
                  </div>
                )}

                {openLeg === "pod" && (
                  <div className="space-y-3">
                    {grns.length === 0
                    ? <p className="text-xs text-muted-foreground">No goods receipt synced against this invoice yet.</p>
                    : <table className="w-full text-[11px]">
                        <thead>
                          <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
                            <th>GRN</th><th>SKU</th><th>Inward PO</th><th>Batch</th><th>Received</th>
                            <th className="text-right" title="Passed QC — good, sellable stock">QC passed</th><th className="text-right">Rejected</th>
                            <th className="text-right">Rate</th>
                            <th className="text-right">QC passed ₹</th>
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
                        <tfoot className="border-t-2 border-border">
                          <tr className="[&>td]:px-1.5 [&>td]:py-1 [&>td]:font-medium">
                            <td colSpan={5} className="text-muted-foreground">
                              Total · {grnAll.grns} GRN{grnAll.grns === 1 ? "" : "s"}
                            </td>
                            <td className="text-right tabular-nums">{qty(grnAll.accepted)}</td>
                            <td className={cn("text-right tabular-nums",
                              grnAll.rejected > 0 && "text-amber-700 dark:text-amber-400")}>
                              {qty(grnAll.rejected)}
                            </td>
                            <td />
                            <td className="text-right tabular-nums">{money(grnAll.acceptedValue)}</td>
                            <td className={cn("text-right tabular-nums",
                              grnAll.rejectedValue > 0 && "text-amber-700 dark:text-amber-400")}>
                              {money(grnAll.rejectedValue)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    }

                    <SkuSummary
                      title="By SKU"
                      head={["SKU", "QC passed", "Rejected", "QC passed ₹", "Rejected ₹", "GRNs"]}
                      note={grnAll.unpriced ? "some lines unpriced" : undefined}
                      rows={grnTotalsBySku(grns).map((g) => [
                        g.sku, qty(g.accepted),
                        g.rejected > 0
                          ? <span className="font-medium text-amber-700 dark:text-amber-400">{qty(g.rejected)}</span>
                          : qty(g.rejected),
                        g.unpriced && g.acceptedValue === 0 ? "—" : money(g.acceptedValue),
                        g.unpriced && g.rejectedValue === 0 ? "—" : money(g.rejectedValue),
                        g.grns,
                      ])}
                    />
                  </div>
                )}

                {openLeg === "inv" && (
                  <div className="space-y-3">
                    {/* EVERY document for this invoice lives here — ours and the
                        warehouse's signed copy alike. They are all copies of the
                        same document, and splitting them across two cards meant
                        hunting in two places for one PDF. */}
                    <div className="flex flex-wrap items-center gap-2">
                      {invoice.attachment_key && (
                        <Button size="xs" variant="outline" onClick={() => void openKey(invoice.attachment_key!)}>
                          <FileText className="h-3 w-3" /> Original invoice <ExternalLink className="h-2.5 w-2.5" />
                        </Button>
                      )}
                      {signedCopies.map((d) => (
                        <Button key={d.id} size="xs" variant="outline" onClick={() => void openKey(d.s3_key)}>
                          <FileText className="h-3 w-3" />
                          <span className="max-w-44 truncate" title={d.filename}>{d.filename}</span>
                          <span className="text-muted-foreground">signed copy</span>
                          <ExternalLink className="h-2.5 w-2.5" />
                        </Button>
                      ))}
                      {ourCopies.map((d) => (
                        <Button key={d.id} size="xs" variant="outline" onClick={() => void openKey(d.s3_key)}>
                          <FileText className="h-3 w-3" />
                          <span className="max-w-40 truncate" title={d.filename}>{d.filename}</span>
                          <span className="text-muted-foreground">pushed</span>
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
                    {!invoice.attachment_key && documents.length === 0 && !docNote && (
                      <p className="text-xs text-muted-foreground">No invoice document stored.</p>
                    )}
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
                            <td className="text-right tabular-nums">{money(li.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                      {/* The per-line column is taxable value; GST and the
                          payable appear nowhere else on this panel. */}
                      <tfoot className="border-t-2 border-border">
                        <tr className="[&>td]:px-1.5 [&>td]:py-1 [&>td]:font-medium">
                          <td colSpan={3} className="text-muted-foreground">
                            Total · {items.length} line{items.length === 1 ? "" : "s"}
                          </td>
                          <td className="text-right tabular-nums">{qty(totals.qty)}</td>
                          <td className="text-right text-muted-foreground">
                            <span className="font-normal">+GST {gstRateLabel(totals.gstRate)} </span>{money(totals.gst)}
                          </td>
                          <td className="text-right tabular-nums">{money(totals.taxable)}</td>
                        </tr>
                        <tr className="[&>td]:px-1.5 [&>td]:pb-1">
                          <td colSpan={5} className="text-right text-muted-foreground">Payable</td>
                          <td className="text-right font-semibold tabular-nums">{money(totals.gross)}</td>
                        </tr>
                      </tfoot>
                    </table>

                    <SkuSummary
                      title="By SKU"
                      head={["SKU", "Qty", "Taxable", "GST", "Payable", "Lines"]}
                      rows={lineTotalsBySku(items).map((sk) => [
                        sk.sku, qty(sk.qty), money(sk.taxable),
                        <span key="x">{money(sk.gst)}
                          <span className="ml-1 text-muted-foreground">{gstRateLabel(sk.gstRate)}</span>
                        </span>,
                        <span key="g" className="font-medium">{money(sk.gross)}</span>,
                        sk.lines,
                      ])}
                    />
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

        <DialogFooter className="items-center">
          {dirtyLegs.length > 0 && (
            <>
              <span className="mr-auto text-[11px] text-amber-700 dark:text-amber-400">
                {dirtyLegs.length} unsaved change{dirtyLegs.length === 1 ? "" : "s"}
              </span>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(savedLegs)}>
                Discard
              </Button>
            </>
          )}
          {/* Close is not a Dialog.Close while there are staged changes — the
              guard below has to run, or a stray click loses the sign-offs. */}
          <Button variant="outline" size="sm" disabled={saving} onClick={requestClose}>Close</Button>
          <Button size="sm" disabled={saving || dirtyLegs.length === 0} onClick={() => void saveVerifications()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save verifications"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
