// Three-way match for one invoice: PO (ordered) · INV (billed) · GRN (accepted).
// PURE — no DB, no network, so tests/unit can import it.
//
// The GRN leg is keyed `pod` throughout — in this type, in the API body and in
// invoice_leg_verification.leg's ENUM. Only the label users read is "GRN". Same
// arrangement as BOM/Recipe: renaming the code means an ENUM migration plus an
// UPDATE of every stored row, for no gain.

import { reconcile } from "@/lib/uniware/grn-totals"

/** 2%, the band scripts/_check-invoice-reconciliation.ts already uses. NOT
 *  poTolerance() (10%, capped 100) — that decides when a PO auto-closes. */
export const MATCH_TOLERANCE = 0.02

/**
 * missing    the document is not on file
 * variance   on file, the numbers disagree
 * unverified on file, numbers agree, nobody has physically checked it
 * ok         on file, numbers agree, a person signed it off
 *
 * Verification is orthogonal to the arithmetic: a variance stays a variance
 * after it is verified. Signing off says "I have seen this document", never
 * "the gap is fine".
 */
export type LegState = "ok" | "unverified" | "variance" | "missing"
export type Leg = { state: LegState; note: string | null; verified: boolean }
export type MatchBadge =
  | "fully_matched" | "awaiting_verification" | "variance" | "invoice_matched" | "unmatched"

/** Which legs a human has physically checked. */
export type LegVerification = { po: boolean; pod: boolean; inv: boolean }

/**
 * "inv,po" → { inv: true, po: true }. NULL/absent means nothing verified.
 *
 * Split on the comma, never a substring test: "pod" CONTAINS "po", so
 * `csv.includes("po")` reports the PO leg verified whenever only the GRN is.
 */
export function parseVerifiedLegs(csv: string | null | undefined): LegVerification {
  const set = new Set((csv ?? "").split(",").filter(Boolean))
  return { po: set.has("po"), pod: set.has("pod"), inv: set.has("inv") }
}

/**
 * The four states a PERSON sets. Stored in invoice_payment.status, and the ENUM
 * there holds exactly these — a stored row can never claim a derived state.
 */
export type ManualPaymentStatus = "pending" | "initiated" | "approved" | "completed"

/**
 * Where the invoice sits on the way to being paid.
 *
 * The first three are DERIVED from the match — the paperwork does or does not
 * support paying — and nobody sets them. The last four are set by hand, and once
 * one is stored it wins: the match still describes the documents, but only a
 * person knows whether the money moved.
 *
 *   awaiting_documents     a leg is missing
 *   awaiting_verification  documents on file, numbers agree, signatures pending
 *   blocked                the documents disagree — settle it before paying
 *   pending → initiated → approved → completed
 */
export type PaymentStatus = "awaiting_documents" | "awaiting_verification" | "blocked" | ManualPaymentStatus

export type ThreeWayMatch = {
  po: Leg
  pod: Leg
  inv: Leg
  /** Legs on file — the "n/3" beside the chips. Amber counts as on file. */
  onFile: number
  /** Legs a person has signed off. Never inferred from the arithmetic. */
  verifiedCount: number
  badge: MatchBadge
  label: string
  reason: string | null
  payment: PaymentStatus
  paymentLabel: string
  /** True when a person set it, false when it is derived from the match. */
  paymentIsManual: boolean
  /** Moved past Pending while the documents don't yet support it. */
  paymentAheadOfDocuments: boolean
}

/** From the list query. DECIMALs arrive from mysql2 as strings. */
export type ThreeWayInput = {
  billedQty:       number | string | null
  poCount:         number | string | null
  poUnlinkedLines: number | string | null
  itemCount:       number | string | null
  linesValue:      number | string | null
  invoiceTotal:    number | string | null
  grnCount:        number | string | null
  grnAccepted:     number | string | null
  grnRejected:     number | string | null
  /** Omitted = nothing verified, which is the correct reading of no rows. */
  verified?:       Partial<LegVerification>
  /** A stored manual payment state. Absent = derive it from the match. */
  paymentStatus?:  ManualPaymentStatus | null
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Line totals, before and after GST.
 *
 * `amount` and `total_amount` hold the SAME figure on every prod row — the
 * taxable value, qty × rate. Neither carries tax, so the payable has to be
 * computed, and a column labelled "Line Total" is pre-GST however it reads.
 *
 * Grossed per line, not by applying one rate to the sum: an invoice may mix GST
 * rates, and 18% happens to be uniform today only by accident of what has been
 * bought so far.
 *
 * `gross` is deliberately the same arithmetic as lines_value in the list query,
 * so the totals row and the INV leg can never disagree about what the lines add
 * up to.
 */
export function lineTotals(
  lines: readonly { qty?: unknown; amount?: unknown; gst_percent?: unknown }[]
): { qty: number; taxable: number; gst: number; gross: number; gstRate: number | null } {
  let qty = 0, taxable = 0, gst = 0
  // The rate to PRINT beside the amount. One distinct rate is a fact worth
  // showing; two or more is `null`, and the caller says "mixed" rather than
  // picking one or averaging into a rate no line actually carries.
  const rates = new Set<number>()
  for (const l of lines) {
    const amount = num(l.amount)
    qty     += num(l.qty)
    taxable += amount
    gst     += amount * num(l.gst_percent) / 100
    rates.add(num(l.gst_percent))
  }
  return {
    qty, taxable, gst, gross: taxable + gst,
    gstRate: rates.size === 1 ? [...rates][0] : null,
  }
}

/**
 * The same totals, one row per SKU.
 *
 * Worth its own view because an invoice legitimately carries one SKU on several
 * lines — different batches, or a quantity the FIFO matcher split across two
 * orders — so "how much of this SKU did we buy" is not answerable by reading any
 * single line. Insertion-ordered, so it follows the document rather than
 * re-sorting into an order nobody chose.
 */
export function lineTotalsBySku<T extends { sku_code?: string | null }>(
  lines: readonly (T & { qty?: unknown; amount?: unknown; gst_percent?: unknown })[]
): ({ sku: string; lines: number } & ReturnType<typeof lineTotals>)[] {
  const groups = new Map<string, typeof lines[number][]>()
  for (const l of lines) {
    const sku = l.sku_code ?? "—"
    const g = groups.get(sku)
    if (g) g.push(l)
    else groups.set(sku, [l])
  }
  return [...groups.entries()].map(([sku, rows]) => ({ sku, lines: rows.length, ...lineTotals(rows) }))
}

/** The rate to print beside a GST amount. "mixed" when the lines disagree —
 *  never an average, which is a rate no line actually carries. */
export const gstRateLabel = (rate: number | null): string =>
  rate == null ? "mixed" : `${Number.isInteger(rate) ? rate : rate.toFixed(2)}%`

export type SkuThreeWay = {
  sku: string
  /** INV */
  lines: number
  billedQty: number
  taxable: number
  gst: number
  gross: number
  /** The single rate this SKU was taxed at, or null when its lines differ. */
  gstRate: number | null
  /** GRN */
  accepted: number
  rejected: number
  /** Gross at the dock — accepted + rejected. */
  arrived: number
  grns: number
  acceptedValue: number
  rejectedValue: number
  unpriced: boolean
  /** Billed but not accounted for at the dock, and its opposite. One-sided for
   *  the same reason reconcile() splits them: chase the manufacturer vs query
   *  the warehouse are different jobs. */
  awaited: number
  overReceipt: number
  /** Received but on no invoice line — a SKU nobody billed us for. */
  unbilled: boolean
  /** Billed with nothing received against it yet. */
  noReceipt: boolean
}

/**
 * The three legs per SKU, for the drilldown's opening view.
 *
 * The only place billed and accepted meet at SKU grain: the invoice panel knows
 * what was charged, the GRN panel knows what arrived, and "which SKU is short"
 * is answerable from neither alone.
 *
 * Keyed on the UNION of both sides, invoice lines first. A SKU present only in
 * the receipts is kept and flagged rather than dropped — that is the warehouse
 * booking something we never billed for, which is a finding, not a blank row.
 */
export function threeWayBySku(
  items: readonly { sku_code?: string | null; qty?: unknown; amount?: unknown; gst_percent?: unknown }[],
  grns: readonly { sku_code?: string | null; grn_code?: string; quantity?: unknown; rejected_qty?: unknown; po_unit_price?: unknown }[]
): SkuThreeWay[] {
  const billed  = new Map(lineTotalsBySku(items).map((s) => [s.sku, s]))
  const arrived = new Map(grnTotalsBySku(grns).map((g) => [g.sku, g]))

  // Invoice order first, then receipt-only SKUs — the document leads.
  const skus = [...billed.keys(), ...[...arrived.keys()].filter((s) => !billed.has(s))]

  return skus.map((sku) => {
    const b = billed.get(sku)
    const a = arrived.get(sku)
    const r = reconcile({
      invoicedQty: b?.qty ?? 0,
      accepted: a?.accepted ?? 0,
      rejected: a?.rejected ?? 0,
    })
    return {
      sku,
      lines: b?.lines ?? 0,
      billedQty: b?.qty ?? 0,
      taxable: b?.taxable ?? 0,
      gst: b?.gst ?? 0,
      gross: b?.gross ?? 0,
      gstRate: b?.gstRate ?? null,
      accepted: a?.accepted ?? 0,
      rejected: a?.rejected ?? 0,
      arrived: a?.arrived ?? 0,
      grns: a?.grns ?? 0,
      acceptedValue: a?.acceptedValue ?? 0,
      rejectedValue: a?.rejectedValue ?? 0,
      unpriced: a?.unpriced ?? false,
      awaited: r.awaited,
      overReceipt: r.overReceipt,
      unbilled: b == null,
      noReceipt: a == null,
    }
  })
}

export type MatchSummary = {
  invoices: number
  byBadge: Record<MatchBadge, number>
  /** Invoices with that leg on file — amber counts, missing does not. */
  onFile: { po: number; inv: number; pod: number }
  /** Invoices with that leg physically signed off. */
  verified: { po: number; inv: number; pod: number }
  /** Invoices where a leg's numbers disagree. */
  variance: { po: number; inv: number; pod: number }
  /** Σ of the per-invoice n/3, for "47 of 165 documents on file". */
  documentsOnFile: number
  signatures: number
}

/**
 * Roll the match up across a set of invoices.
 *
 * Takes the same input threeWayMatch does and calls it, rather than counting
 * from the badge strings — so the strip above the table and the chips inside it
 * cannot disagree about what "variance" means.
 */
export function summariseMatches(rows: readonly ThreeWayInput[]): MatchSummary {
  const byBadge: Record<MatchBadge, number> = {
    fully_matched: 0, awaiting_verification: 0, variance: 0, invoice_matched: 0, unmatched: 0,
  }
  const onFile   = { po: 0, inv: 0, pod: 0 }
  const verified = { po: 0, inv: 0, pod: 0 }
  const variance = { po: 0, inv: 0, pod: 0 }
  let documentsOnFile = 0, signatures = 0

  for (const r of rows) {
    const m = threeWayMatch(r)
    byBadge[m.badge]++
    documentsOnFile += m.onFile
    signatures      += m.verifiedCount
    for (const k of ["po", "inv", "pod"] as const) {
      if (m[k].state !== "missing")  onFile[k]++
      if (m[k].verified)             verified[k]++
      if (m[k].state === "variance") variance[k]++
    }
  }
  return { invoices: rows.length, byBadge, onFile, verified, variance, documentsOnFile, signatures }
}

export type GrnTotals = {
  /** Passed QC — good, sellable stock. quantity MINUS rejected. */
  accepted: number
  rejected: number
  /** What came in the box, rejections included: Uniware's raw `quantity`. */
  arrived: number
  /** Only the priced lines. `unpriced` says whether that is the whole story. */
  acceptedValue: number
  rejectedValue: number
  /** A receipt line whose inward PO carries no rate — unknown value, not zero. */
  unpriced: boolean
  /** Distinct receipts, not line count: one GRN usually carries several lines. */
  grns: number
}

/**
 * Receipt roll-up.
 *
 * ── ACCEPTED MEANS QC-PASSED ─────────────────────────────────────────────────
 * `grn_items_uniware.quantity` is GROSS — what came in the box, rejections
 * included. Confirmed on prod: MPO-INW-202609-023 reads quantity 2496,
 * rejected 1, and Uniware's own un_qc_pass_qty 2495. So the good, sellable
 * figure is quantity MINUS rejected, and that is what `accepted` means here.
 *
 * Reading quantity as accepted counted the rejected units twice — once as good
 * stock and again as rejected — which made `accepted + rejected` overstate what
 * arrived and could turn a short receipt into an apparent over-receipt.
 *
 * `arrived` keeps the gross figure, because "what did the truck bring" and
 * "what can we sell" are both real questions.
 *
 * The rate is OURS — the inward PO's unit_price, since a receipt carries no
 * price of its own — and an unpriced line contributes nothing rather than zero,
 * so a total never understates a loss silently.
 */
export function grnTotals(
  rows: readonly { grn_code?: string; quantity?: unknown; rejected_qty?: unknown; po_unit_price?: unknown }[]
): GrnTotals {
  let accepted = 0, rejected = 0, arrived = 0, acceptedValue = 0, rejectedValue = 0, unpriced = false
  const codes = new Set<string>()
  for (const r of rows) {
    const gross = num(r.quantity), j = num(r.rejected_qty)
    const good = gross - j
    arrived  += gross
    accepted += good
    rejected += j
    if (r.po_unit_price == null) unpriced = true
    else {
      const rate = num(r.po_unit_price)
      acceptedValue += good * rate
      rejectedValue += j * rate
    }
    if (r.grn_code) codes.add(r.grn_code)
  }
  return { accepted, rejected, arrived, acceptedValue, rejectedValue, unpriced, grns: codes.size }
}

/** Receipts rolled up per SKU — one SKU can arrive across several receipts. */
export function grnTotalsBySku<T extends { sku_code?: string | null }>(
  rows: readonly (T & { grn_code?: string; quantity?: unknown; rejected_qty?: unknown; po_unit_price?: unknown })[]
): ({ sku: string } & GrnTotals)[] {
  const groups = new Map<string, typeof rows[number][]>()
  for (const r of rows) {
    const sku = r.sku_code ?? "—"
    const g = groups.get(sku)
    if (g) g.push(r)
    else groups.set(sku, [r])
  }
  return [...groups.entries()].map(([sku, rs]) => ({ sku, ...grnTotals(rs) }))
}

const qty   = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 })
const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
const pct   = (f: number) => `${(f * 100).toFixed(1)}%`
/** Drops the percentage when it isn't finite — "vs PO 0" has no meaningful one. */
const gap   = (d: number, word: string) => (Number.isFinite(d) ? `${pct(d)} ${word}` : word)

/** Relative to `expected`, not the larger: 9,240 of 14,300 is "35.4% short".
 *  Zero expected against a non-zero actual is Infinity, never 0. */
function drift(actual: number, expected: number): number {
  if (expected === 0) return actual === 0 ? 0 : Infinity
  return Math.abs(actual - expected) / expected
}

// The leg builders below report the ARITHMETIC only. Verification is layered on
// afterwards by sign(), so neither can be forgotten in one of the three paths.
const agrees: Leg  = { state: "ok", note: null, verified: false }
const missing  = (note: string): Leg => ({ state: "missing",  note, verified: false })
const variance = (note: string): Leg => ({ state: "variance", note, verified: false })

/**
 * Fold a human sign-off into a leg.
 *
 * Only an `ok` leg is demoted: there is nothing to physically check about a
 * document that is absent, and a variance is already flagged for a reason
 * verification does not settle.
 */
function sign(leg: Leg, verified: boolean): Leg {
  if (leg.state !== "ok") return { ...leg, verified }
  return verified
    ? { ...leg, state: "ok", verified: true }
    : { ...leg, state: "unverified", note: "Agrees on paper — not yet physically verified.", verified: false }
}

const pastTolerance = `past the ${pct(MATCH_TOLERANCE)} tolerance`

/**
 * Presence only — never amber. One PO is settled by up to 20 invoices on prod,
 * so a header-level billed-vs-ordered gap reads "under-billed" on nearly every
 * row; there is no stored per-invoice share to compare against. Over-drawing a
 * PO is already refused at write time by receivePo (400 over_limit).
 *
 * Any unlinked line greys the whole leg — a partly-accounted-for invoice is what
 * the 2026-09 line loss looked like from here.
 */
function poLeg(i: ThreeWayInput): Leg {
  const unlinked = num(i.poUnlinkedLines)
  if (num(i.poCount) === 0) return missing("PO not on file — match cannot advance.")
  if (unlinked > 0) {
    return missing(`${qty(unlinked)} line${unlinked === 1 ? "" : "s"} settled no purchase order — match cannot advance.`)
  }
  return agrees
}

/** No receipt is grey, never a zero: "never synced" and "synced, nothing
 *  booked" are different states but neither advances the match. */
function podLeg(i: ThreeWayInput): Leg {
  if (num(i.grnCount) === 0) return missing("GRN not on file — match cannot advance.")

  const billed = num(i.billedQty)
  const r = reconcile({ invoicedQty: billed, accepted: i.grnAccepted, rejected: i.grnRejected })
  const handled = r.accepted + r.rejected
  if (handled === 0) return missing("Receipts synced but nothing booked yet — match cannot advance.")

  const d = drift(handled, billed)
  if (d > MATCH_TOLERANCE) {
    return variance(`GRN ${qty(handled)} pcs vs billed ${qty(billed)} — ${gap(d, r.awaited > 0 ? "short-received" : "over-received")}, ${pastTolerance}.`)
  }
  // Amber on its own: rejected units are a debit note even when the total reconciles.
  if (r.rejected > 0) return variance(`${qty(r.rejected)} pcs rejected at the dock — raise a debit note.`)
  return agrees
}

/** invoice_total vs its own lines — the comparison the 2026-09 audit named as
 *  the highest-value remaining fix. Visible here; blocks nothing. */
function invLeg(i: ThreeWayInput): Leg {
  if (num(i.itemCount) === 0) return missing("No line items recorded — match cannot advance.")
  const total = num(i.invoiceTotal)
  if (total === 0) return missing("No invoice total on file — the lines reconcile against nothing.")

  const lines = num(i.linesValue)
  if (drift(lines, total) > MATCH_TOLERANCE) {
    return variance(`Lines total ${money(lines)} vs invoice ${money(total)} — ${pct(lines / total)} ${lines < total ? "of" : "over"} the invoice total, ${pastTolerance}.`)
  }
  return agrees
}

const LABEL: Record<MatchBadge, string> = {
  fully_matched:         "Fully matched",
  awaiting_verification: "Awaiting verification",
  variance:              "Variance",
  invoice_matched:       "Invoice matched",
  unmatched:             "Unmatched",
}

/**
 * What the paperwork alone says, before anyone has touched the invoice.
 *
 * One badge, one answer — a second set of rules here could tell the desk a
 * variance is payable while the chips beside it say Variance. `fully_matched`
 * lands on `pending`: verified, and now waiting on finance rather than on
 * documents, which is where the manual lifecycle picks up.
 */
const DERIVED_PAYMENT: Record<MatchBadge, PaymentStatus> = {
  fully_matched:         "pending",
  awaiting_verification: "awaiting_verification",
  variance:              "blocked",
  invoice_matched:       "awaiting_documents",
  unmatched:             "awaiting_documents",
}

const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  awaiting_documents:    "Awaiting documents",
  awaiting_verification: "Awaiting verification",
  blocked:               "Blocked",
  pending:               "Pending",
  initiated:             "Initiated",
  approved:              "Approved",
  completed:             "Completed",
}

/** The manual states, in lifecycle order — the picker reads this. */
export const MANUAL_PAYMENT_STATUSES: readonly ManualPaymentStatus[] =
  ["pending", "initiated", "approved", "completed"] as const

export const paymentLabelOf = (s: PaymentStatus) => PAYMENT_LABEL[s]

/** Only 'completed' claims the money moved, so only it needs the bank reference. */
export const paymentNeedsUtr = (s: ManualPaymentStatus) => s === "completed"

/**
 * A missing leg outranks a variance, and a variance outranks a missing
 * signature: an unmeasurable gap beats a measured one, and a measured one beats
 * paperwork. "Fully matched" is the only state that requires all three
 * signatures, which is the whole point of the verification column — nothing
 * reaches it automatically.
 */
export function threeWayMatch(input: ThreeWayInput): ThreeWayMatch {
  const v = input.verified ?? {}
  const po  = sign(poLeg(input),  v.po  === true)
  const pod = sign(podLeg(input), v.pod === true)
  const inv = sign(invLeg(input), v.inv === true)
  // Display order — PO, INV, GRN — so `reason` reads in the order the chips do.
  // Badge precedence below is order-independent and does not depend on this.
  const legs = [po, inv, pod]

  const badge: MatchBadge =
    po.state === "missing" || inv.state === "missing" ? "unmatched"
    : pod.state === "missing"                         ? "invoice_matched"
    : legs.some((l) => l.state === "variance")        ? "variance"
    : legs.some((l) => l.state === "unverified")      ? "awaiting_verification"
    :                                                   "fully_matched"

  // A stored state wins: the match describes the documents, but only a person
  // knows whether the money moved.
  const derived: PaymentStatus = DERIVED_PAYMENT[badge]
  const payment: PaymentStatus = input.paymentStatus ?? derived

  return {
    po, pod, inv,
    // Unverified still counts as on file — the document is there, the signature
    // is what is missing, and n/3 is about documents.
    onFile: legs.filter((l) => l.state !== "missing").length,
    verifiedCount: legs.filter((l) => l.verified).length,
    badge,
    label: LABEL[badge],
    // Every note — an invoice can be short-received AND under-billed.
    reason: legs.map((l) => l.note).filter(Boolean).join(" ") || null,
    payment,
    paymentLabel: PAYMENT_LABEL[payment],
    paymentIsManual: input.paymentStatus != null,
    // Set by hand while the documents still don't support it. Not refused —
    // finance may legitimately pay ahead of the paperwork — but never silent.
    paymentAheadOfDocuments:
      input.paymentStatus != null && derived !== "pending" && input.paymentStatus !== "pending",
  }
}
