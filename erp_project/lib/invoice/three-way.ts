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
 * Whether the paperwork clears this invoice for payment.
 *
 * DERIVED, not recorded. Nothing in the ERP stores whether an invoice was paid —
 * there is no payment table and no AP module — so this says "the documents do /
 * do not support paying", never "this was paid". A real `paid` state needs the
 * ERP-vs-Tally ownership decision first.
 *
 * Mapped 1:1 off the badge on purpose: a second set of rules here could tell the
 * desk a variance is payable while the badge beside it says Variance.
 */
export type PaymentStatus = "ready" | "pending" | "blocked" | "on_hold"

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
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
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

/** One badge, one payment answer — see PaymentStatus for why it is a map. */
const PAYMENT: Record<MatchBadge, PaymentStatus> = {
  fully_matched:         "ready",     // three documents, three signatures
  awaiting_verification: "pending",   // numbers agree, signatures outstanding
  variance:              "blocked",   // a real disagreement — settle it first
  invoice_matched:       "on_hold",   // documents outstanding
  unmatched:             "on_hold",
}

const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  ready:   "Ready to pay",
  pending: "Pending",
  blocked: "Blocked",
  on_hold: "On hold",
}

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
    payment: PAYMENT[badge],
    paymentLabel: PAYMENT_LABEL[PAYMENT[badge]],
  }
}
