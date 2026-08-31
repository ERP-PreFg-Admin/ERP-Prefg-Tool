/**
 * What gatepasses WOULD be created — the dry run, and nothing more.
 *
 * Ported from sale_order_to_gatepass.py's `plan()` / `line_items()` /
 * `blockers()`. That script refuses to POST until three things are settled, and
 * this keeps the refusal rather than quietly shipping a guess:
 *
 *   1. the create endpoint and payload shape are UNVERIFIED
 *   2. toParty cannot be inferred and is printed on the document
 *   3. (cleared 2026-08-28) line items — see `lineItems` below
 *
 * There is deliberately NO create function here. A dry run has nothing to POST,
 * and `buildGatepassPayload` is the single place the real contract lands when it
 * arrives. Everything else in this file is independent of that shape.
 *
 * Pure — no fetch, no env, no db.
 */

import { COLS, pick, type ExportRow, type PackageTypeRow } from "./summary"
import { gatepassPrefix } from "./gatepass-code"
import { parseIso, MONTH_NAMES } from "@/lib/date"

/** 2,519 of the 2,863 existing gatepasses. */
export const DEFAULT_TYPE = "NON_RETURNABLE"

/**
 * One line of the gatepass: a shipping package type, and how many boxes of it.
 *
 * `code` is a PACKAGE TYPE ("DRY069"), not a SKU. The wire field is still named
 * `itemSKU` — see `buildGatepassPayload`, which is where that guess lives.
 */
export type GatepassItem = { code: string; quantity: number }

export type GatepassPlan = {
  facility: string
  type: string
  /** Null until a facility has one configured — never invented. */
  toParty: string | null
  items: GatepassItem[]
  /** Distinct sale orders behind this gatepass. */
  orders: number
  /** Export rows read, i.e. line items before merging by SKU. */
  rows: number
  /** e.g. "M/AHM/OG/2627/". Null for a facility with no city mapping. */
  prefix: string | null
  sampleOrders: string[]
  /** The window's LAST invoice date, `YYYY-MM-DD` — what the reference reads "till". */
  window?: string
}

/**
 * The gatepass lines: one per shipping package type, quantity = boxes.
 *
 * **A package type IS a box type**, so the number of distinct orders in it is
 * the number of boxes going out under it — which is what the gatepass is
 * counting. That is the whole reason this feature reads package types at all.
 *
 * Not SKUs. An earlier cut built lines from `skuCode`, giving 97 SKU lines and
 * 3,503 units for one facility-day; the document wants 5 lines of box counts,
 * not a picking list. The SKU path is deleted rather than left behind a flag —
 * `COLS.sku_code` and one entry in `SALE_ORDER_COLUMNS` bring it back.
 *
 * Already deduplicated: `summarise` counts DISTINCT orders per type, so an order
 * spanning six line-item rows is one box, not six.
 *
 * An order appearing under two package types contributes a box to each, which is
 * correct — it genuinely ships as two boxes. That is also why it cannot sit on a
 * single gatepass, which `shared_orders` on the summary flags.
 */
export function packageTypeItems(summary: PackageTypeRow[]): GatepassItem[] {
  // Summed ACROSS DATES: the summary is per (date, package type) so a multi-day
  // range has several rows per type, while the gatepass is one document for the
  // whole window. Safe to add — an order is invoiced once, so it appears under
  // exactly one date and cannot be counted twice.
  const boxes = new Map<string, number>()
  for (const r of summary) {
    if (r.orders > 0) boxes.set(r.package_type, (boxes.get(r.package_type) ?? 0) + r.orders)
  }
  return [...boxes.entries()]
    .map(([code, quantity]) => ({ code, quantity }))
    // Biggest first, name as tie-break — stable run to run, and the document
    // reads top-down by what dominates it.
    .sort((a, b) => b.quantity - a.quantity || a.code.localeCompare(b.code))
}

/**
 * One gatepass per facility for the selected window.
 *
 * Grouping is per FACILITY, not per package type: that is the settled rule from
 * the script ("one gatepass per facility per day"), and since the date range only
 * widens the export window, a multi-day range still yields one document per
 * facility covering it.
 */
export function planFacility(
  rows: ExportRow[],
  summary: PackageTypeRow[],
  facility: string,
  opts: { toParty?: string | null; type?: string; at?: Date } = {},
): GatepassPlan {
  // Counted from the export rather than summed off the summary: an order under
  // two package types is two boxes but still ONE order, and summing would
  // silently inflate this.
  const orderCodes = new Set<string>()
  for (const row of rows) {
    const order = pick(row, COLS.order_code)
    if (order) orderCodes.add(order)
  }

  return {
    facility,
    type: opts.type ?? DEFAULT_TYPE,
    toParty: opts.toParty?.trim() || null,
    items: packageTypeItems(summary),
    orders: orderCodes.size,
    rows: rows.length,
    prefix: gatepassPrefix(facility, opts.at ?? new Date()),
    sampleOrders: [...orderCodes].sort().slice(0, 5),
  }
}

/**
 * The create-gatepass request body — the REAL schema, verified 2026-08-28.
 *
 *   { type, partyCode, wsGatePass: { code, purpose, transferAmount,
 *                                    referenceNumber, customFieldValues } }
 *
 * This creates an EMPTY document. The box counts do not travel in it at all:
 * they are added afterwards, one call each, through
 * `/purchase/gatepass/nontraceable/addItem` — see lib/gatepass/create.ts.
 *
 * Corrections this file has already had to make, each confirmed against the live
 * API rather than inferred:
 *
 *  - There is **no `gatepass` wrapper**. `CreateGatePassRequest` rejects it as an
 *    unrecognized field; the three keys are top level.
 *  - `code` lives **inside `wsGatePass`**, not at top level. Supplying it is what
 *    lets this automation own its own `…/DRY/…` series; OMITTING it makes Uniware
 *    number the document in the facility's hand-raised series, which is how
 *    M/AHM/OG/2627/0013 came about.
 *  - `customFieldValues` used to carry the box counts here, as a workaround from
 *    when the items endpoint was unknown. **Removed** — sending the same
 *    quantities both as custom fields and as real lines is one number in two
 *    places that can disagree, and the custom fields were never registered on the
 *    tenant anyway. The lines are the record.
 */
export function buildGatepassPayload(
  plan: GatepassPlan,
  code: string | null,
): Record<string, unknown> {
  return {
    type: plan.type,
    partyCode: plan.toParty,
    wsGatePass: {
      // Null is meaningful: it hands numbering back to Uniware. This automation
      // always passes its own code so its series stays separate from the one
      // people raise by hand.
      code,
      referenceNumber: gatepassReference(plan.window),
    },
  }
}

/**
 * What goes on the document as its reference, e.g. `Dry Consumption Till 26 Aug`.
 *
 * Matches the wording the desk already writes by hand — the live
 * M/AHM/OG/2627/0012 carries exactly "Dry Consumption Till 26 Aug" — so an
 * automated gatepass reads the same as a manual one on the same shelf, instead
 * of announcing itself with an ISO date nobody else uses.
 *
 * "Till" is the window's LAST day: the document covers everything invoiced up to
 * and including it, which is what a reader of "till 26 Aug" expects. No year —
 * the code's own FY segment already carries that, and the hand-written ones omit
 * it too.
 *
 * An unparseable or missing date gives an empty string rather than "Invalid
 * Date", following `formatDisplay` in lib/date.ts — a blank reference is
 * recoverable, a printed "NaN" is not.
 */
export function gatepassReference(lastDay: string | undefined): string {
  const p = lastDay ? parseIso(lastDay) : null
  return p ? `Dry Consumption Till ${p.d} ${MONTH_NAMES[p.m - 1]}` : ""
}

/**
 * Why a live run must refuse, checked against the plan actually built.
 *
 * Returned as a list rather than a boolean because the reader has to fix them,
 * and the last one is not fixable from here at all.
 */
export function blockers(plans: GatepassPlan[]): string[] {
  const problems: string[] = []

  if (plans.length === 0) {
    problems.push("No sale orders matched this window — there is nothing to create.")
  }

  const noItems = plans.filter((p) => p.items.length === 0).map((p) => p.facility)
  if (noItems.length > 0) {
    problems.push(
      `No package types for ${noItems.join(", ")} — nothing shipped in this window, ` +
      `so those gatepasses would be empty.`
    )
  }

  const noParty = plans.filter((p) => !p.toParty).map((p) => p.facility)
  if (noParty.length > 0) {
    problems.push(
      `toParty is not set for ${noParty.join(", ")} — it is printed on the document, ` +
      `so it must be configured in lib/gatepass/facilities.ts rather than defaulted.`
    )
  }

  const noPrefix = plans.filter((p) => !p.prefix).map((p) => p.facility)
  if (noPrefix.length > 0) {
    problems.push(
      `No code prefix for ${noPrefix.join(", ")} — the facility has no city mapping in ` +
      `lib/gatepass/gatepass-code.ts, so Unicommerce has no series to number it in.`
    )
  }

  // NOTE: there is deliberately no unconditional blocker any more. Creating was
  // held back while the payload was unverified; it is verified now, and the one
  // remaining unknown — whether the package-type `customFieldValues` are
  // registered in Unicommerce — can only be settled by a real create. Removed on
  // request, 2026-08-28, so that can be checked directly.
  //
  // What is left here still refuses: no orders, no toParty, no code prefix. Those
  // are all knowable without sending anything, so they stay.
  return problems
}
