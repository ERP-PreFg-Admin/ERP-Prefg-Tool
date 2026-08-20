/**
 * The four states a (manufacturer, facility) cell can be in on the MFG × Facility
 * matrix, and the ONE place their colour is defined.
 *
 * The legend, the cell washes, the summary pills and the drilldown panel's badge
 * all read the Record maps below, so a cell can never be a different colour from
 * the legend entry that explains it. Four parallel Records rather than one Record
 * of objects, matching EFFECT_LABEL / EFFECT_TEXT / EFFECT_DOT in
 * app/admin/authority.ts:149-170 — and it means adding a fifth state is a compile
 * error in every consumer that forgot it, not a silent drift.
 *
 * Pure module, no React, no lib/db — so tests/unit/mfg-facility-map.test.ts can
 * reach it. A useMemo inside the client component could not be tested at all.
 */

import { DIFF_NEW_CELL_CLASS } from "@/app/approvals/approval-card/diff-colors"
import { MISSING_CELL_CLASS } from "@/components/masters/missing-value"

export type MapState = "mapped" | "partial" | "unmapped" | "unavailable"

/** Render order for the legend, and the order the summary pills appear in. */
export const MAP_STATES = ["mapped", "partial", "unmapped", "unavailable"] as const

/**
 * Cell wash + text colour. Also the panel badge's className (via
 * `<Badge variant="outline">`), so the badge matches the cell it was opened from.
 *
 * Reuses the app's existing tokens rather than hand-rolling emerald-6xx/7xx pairs
 * that drift — that is the exact warning in diff-colors.ts:3-7.
 */
export const MAP_STATE_CELL: Record<MapState, string> = {
  mapped: DIFF_NEW_CELL_CLASS,
  // Amber, and for the same stated reason as MISSING_CELL_CLASS
  // (components/masters/missing-value.ts:14-15): a half-filled cell is data still
  // to be entered, not an error.
  partial: MISSING_CELL_CLASS,
  // Rose rather than red: still "you have work here", not "this is wrong". Red
  // stays reserved for DIFF_OLD's meaning. Matches the rose triple in
  // app/approvals/approvals-types.ts:118, minus its border.
  unmapped: "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400",
  unavailable: "bg-muted/30 text-muted-foreground",
}

/**
 * The matrix cell itself, where the colour fills the WHOLE cell rather than a pill
 * inside it.
 *
 * A separate set from MAP_STATE_CELL, not a reuse of it, because area changes what
 * a colour does: the -50 washes above are tuned for a chip a few characters wide,
 * and at full cell size a grid of them reads as garish. These are one step deeper
 * in hue but calmer in effect, with text pushed to -900 to hold contrast against
 * the heavier ground.
 *
 * `unavailable` is TRANSPARENT on purpose. It is 74% of the grid (240 of 324 cells
 * on current data) — filling all of it with grey would bury the 84 cells that carry
 * information under three times their own weight in furniture. Empty ground is what
 * makes the coloured cells legible.
 */
export const MAP_STATE_BLOCK: Record<MapState, string> = {
  mapped: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  unmapped: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-300",
  unavailable: "text-muted-foreground/50",
}

/** The legend swatch. Saturated, because a 6px dot needs more contrast than a
 *  full cell wash to read at all. */
export const MAP_STATE_DOT: Record<MapState, string> = {
  mapped: "bg-emerald-600 dark:bg-emerald-400",
  partial: "bg-amber-500 dark:bg-amber-400",
  unmapped: "bg-rose-500 dark:bg-rose-400",
  unavailable: "bg-muted-foreground/40",
}

export const MAP_STATE_TEXT: Record<MapState, string> = {
  mapped: "text-emerald-700 dark:text-emerald-400",
  partial: "text-amber-700 dark:text-amber-400",
  unmapped: "text-rose-700 dark:text-rose-400",
  unavailable: "text-muted-foreground",
}

export const MAP_STATE_LABEL: Record<MapState, string> = {
  mapped: "All mapped",
  partial: "Partial",
  unmapped: "Not mapped",
  unavailable: "Not available",
}

/** One cell's numbers, as the matrix query returns them. */
export type MatrixCell = {
  /** The Uniware vendor code for this (mfg, facility), or null if there is none.
   *  Null is the cell's existence test — see cellState. */
  un_mfg_code: string | null
  /** details_warehouse_entity.facility_code. Null means Uniware cannot be
   *  addressed for this facility at all, whatever else is configured. */
  facility_code: string | null
  /** Live SKU lines on this manufacturer — the denominator. Same for every cell
   *  in the row. */
  total_skus: number
  /** Of those, how many are mapped at this facility. */
  mapped_skus: number
  /** Mapped here but not yet acknowledged by Uniware (neither pushed nor seen).
   *  Drives the warning overlay, NOT a fifth state. */
  unpushed_skus: number
}

/**
 * Which of the four states a cell is in.
 *
 * The ordering of these branches is the whole logic, so it is worth reading in
 * order rather than as a table:
 *
 *  1. No `facility_code` — nothing to send as Uniware's Facility header, so no
 *     mapping here can ever take effect. Grey regardless of anything else.
 *  2. No `un_mfg_code` — this manufacturer is not a vendor at this facility, so
 *     no SKU there CAN be mapped and no PO can carry a vendorCode. This is the
 *     vendor-code row's entire purpose. Grey.
 *  3. No SKUs on the manufacturer — grey, NOT green. "All of nothing is mapped"
 *     is true and useless; painting it green claims finished work that does not
 *     exist.
 *  4. Then the counts decide: 0 → unmapped, all → mapped, between → partial.
 *
 * `mapped_skus` is clamped to `total_skus`. A stale or duplicate row would
 * otherwise render "4" against a total of 3 and read as a bug on this screen,
 * when the actual problem is in the data.
 */
export function cellState(cell: MatrixCell): MapState {
  if (!cell.facility_code) return "unavailable"
  if (!cell.un_mfg_code) return "unavailable"
  if (cell.total_skus <= 0) return "unavailable"

  const mapped = Math.min(Math.max(cell.mapped_skus, 0), cell.total_skus)
  if (mapped === 0) return "unmapped"
  return mapped >= cell.total_skus ? "mapped" : "partial"
}

/** What the cell prints. A grey cell shows an em dash, not "0" — zero of zero is
 *  not a number worth reading, and the dash is what marks it as inert. */
export function cellLabel(cell: MatrixCell): string {
  if (cellState(cell) === "unavailable") return "—"
  return String(Math.min(Math.max(cell.mapped_skus, 0), cell.total_skus))
}

/** True when this cell is mapped but Uniware has not confirmed some of it — the
 *  corner warning dot. Deliberately not a state: the screenshot has four. */
export function needsPush(cell: MatrixCell): boolean {
  return cellState(cell) !== "unavailable" && cell.unpushed_skus > 0
}

/**
 * The three summary pills.
 *
 * Computed over the FILTERED rows, so narrowing the search narrows the headline
 * numbers too — otherwise the pills describe a grid the user cannot see.
 *
 * `unmapped` and `partial` count CELLS (how many places need attention), while
 * `missing` counts SKU-SLOTS (how much work that actually is). Those are
 * genuinely different questions and the screenshot shows all three, so both units
 * are present on purpose.
 */
export function summarise(cells: MatrixCell[]): {
  unmapped: number
  partial: number
  missing: number
} {
  let unmapped = 0
  let partial = 0
  let missing = 0
  for (const cell of cells) {
    const state = cellState(cell)
    if (state === "unmapped") unmapped++
    if (state === "partial") partial++
    if (state === "unmapped" || state === "partial") {
      missing += cell.total_skus - Math.min(Math.max(cell.mapped_skus, 0), cell.total_skus)
    }
  }
  return { unmapped, partial, missing }
}

/**
 * Does this manufacturer's row survive the search box?
 *
 * Rows only — never columns. A cell is a count with nothing inside it to
 * highlight, and dropping facility columns mid-search would silently change the
 * matrix's shape. A SKU match therefore keeps its manufacturer's whole row, and
 * the drilldown panel is where you see which SKU it was.
 */
export function matchesSearch(
  mfg: { name: string; code: string | null },
  skuText: string[],
  search: string,
): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return [mfg.name, mfg.code, ...skuText]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q))
}
