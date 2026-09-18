"use client"

// The 3-way (PO · INV · GRN) chip group on the invoice row. Clicking it opens
// the drilldown — there is no verdict column; the dialog carries that.
// All arithmetic lives in lib/invoice/three-way.ts; this file only paints it.

import { CreditCard, FileText, Package } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { parseVerifiedLegs, threeWayMatch, type Leg, type LegState, type PaymentStatus, type ThreeWayMatch } from "@/lib/invoice/three-way"

// Re-exported so the dialog keeps importing it from here.
export { parseVerifiedLegs }
import type { InvoiceHistoryHeader } from "@/types/invoice"

/** One row's match. Exported so the dialog and the summary line agree with the cell. */
export function matchOf(inv: InvoiceHistoryHeader): ThreeWayMatch {
  return threeWayMatch({
    verified: parseVerifiedLegs(inv.verified_legs),
    paymentStatus: inv.payment_status ?? null,
    billedQty:       inv.billed_qty        ?? 0,
    poCount:         inv.po_count          ?? 0,
    poUnlinkedLines: inv.po_unlinked_lines ?? 0,
    itemCount:       inv.item_count        ?? 0,
    linesValue:      inv.lines_value       ?? 0,
    invoiceTotal:    inv.invoice_total     ?? 0,
    grnCount:        inv.grn_count         ?? 0,
    grnAccepted:     inv.grn_accepted      ?? 0,
    grnRejected:     inv.grn_rejected      ?? 0,
  })
}

// Green is reserved for a leg a person signed off. "unverified" is the document
// being present and the numbers agreeing — real progress, but not sign-off, so
// it reads as outlined rather than filled.
const CHIP: Record<LegState, string> = {
  ok:         "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400",
  unverified: "border-border bg-background text-foreground/70 border-dashed",
  variance:   "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400",
  missing:    "border-border bg-muted text-muted-foreground",
}

const ICON = { po: FileText, pod: Package, inv: CreditCard }

// "GRN" is the label only — the leg is keyed `pod` everywhere else, including
// the stored ENUM. See the header of lib/invoice/three-way.ts.
const LEG_LABEL = {
  po:  "PO — purchase order raised",
  inv: "INV — supplier tax invoice",
  pod: "GRN — goods receipt at site, with the signed copy",
}

function Chip({ leg, kind }: { leg: Leg; kind: keyof typeof ICON }) {
  const Icon = ICON[kind]
  return (
    <span
      className={cn("inline-flex h-6 w-6 items-center justify-center rounded-md border", CHIP[leg.state])}
      // The note when there is one, so the chip explains itself without the dialog.
      title={leg.note ? `${LEG_LABEL[kind]} — ${leg.note}` : LEG_LABEL[kind]}
      aria-label={LEG_LABEL[kind]}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
}

/**
 * The three chips, the n/3 tally, and the way into the drilldown.
 *
 * The chips ARE the button — the row's own click expands it into line items, so
 * the drilldown needs a target that isn't the row. The verdict and its reason
 * live in the dialog rather than a column of their own; hover carries them so
 * the list still answers "why" without one.
 */
export function ThreeWayChips({ m, onOpen }: { m: ThreeWayMatch; onOpen: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      title={m.reason ? `${m.label} — ${m.reason}` : m.label}
      className="rounded-md px-1 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5">
        <Chip leg={m.po}  kind="po" />
        <Chip leg={m.inv} kind="inv" />
        <Chip leg={m.pod} kind="pod" />
        <span className="ml-0.5 tabular-nums text-muted-foreground">{m.onFile}/3</span>
      </span>
      {/* Its own line: documents and signatures are different counts, and side
          by side the two numbers read as one fraction. */}
      <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
        {m.verifiedCount}/3 verified
      </span>
    </button>
  )
}

const PAYMENT_BADGE: Record<PaymentStatus, "success" | "warning" | "destructive" | "secondary" | "info" | "outline"> = {
  awaiting_documents:    "warning",
  awaiting_verification: "outline",
  blocked:               "destructive",
  pending:               "secondary",
  initiated:             "info",
  approved:              "info",
  completed:             "success",
}

/**
 * Where the invoice sits on the way to being paid, and the way to move it.
 *
 * The dashed border marks a DERIVED state — the match's reading of the
 * paperwork, which nobody has overridden. Once a person sets a state it renders
 * solid, because "the documents look fine" and "finance has approved this" are
 * different claims and the column has to keep them apart.
 */
export function PaymentCell({ m, utr, onOpen }: {
  m: ThreeWayMatch
  utr?: string | null
  onOpen: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      className="block text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md"
      title={m.paymentIsManual
        ? `${m.paymentLabel} — set by hand. Click to change.`
        : `${m.paymentLabel} — from the three-way match, nobody has set it. Click to change.`}
    >
      <Badge
        variant={PAYMENT_BADGE[m.payment]}
        className={cn("cursor-pointer hover:opacity-80", !m.paymentIsManual && "border border-dashed")}
      >
        {m.paymentLabel}
      </Badge>
      {/* The bank reference is the proof the money moved — it belongs beside
          Completed, not hidden in a dialog. */}
      {utr && (
        <span className="mt-0.5 block max-w-32 truncate font-mono text-[10px] text-muted-foreground" title={`UTR ${utr}`}>
          {utr}
        </span>
      )}
      {m.paymentAheadOfDocuments && (
        <span
          className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-400"
          title="Moved past Pending while the three-way match is not clear"
        >
          ahead of documents
        </span>
      )}
    </button>
  )
}
