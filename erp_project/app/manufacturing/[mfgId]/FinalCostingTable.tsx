"use client"

import { Fragment, useState } from "react"
import Link from "next/link"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { PaginationBar } from "@/components/ui/pagination-bar"
import type { FinalCostingRow, FinalCostingComparisonRow } from "@/types/masters"
import {
  CostingHeadRow, CostingCells, ScenarioLabelRow, ScenarioHeadRow,
  COSTING_COL_COUNT,
} from "./costing-columns"
import { rateGapReasons } from "./costing-gaps"
import type { CostingBreakup } from "./costing-breakup"
import CostingBreakupPanel from "./CostingBreakupPanel"

/** The two things a row can expand into. One slot, so they never stack. */
type Panel = "scenarios" | "breakup"

/** Every cell of this table's rows, including the trailing Actions column. */
const COL_COUNT = COSTING_COL_COUNT + 1

// Why a costing is incomplete, named precisely rather than guessed.
//
// This used to say "possibly missing: RM cost" for every zero, which sent people
// to the rate master — but the usual cause is the SKU having no fill weight.
// The precise reasons now live in costing-gaps.ts, shared with the SKUs tab;
// only the vague fallback below is specific to this table (it needs the
// computed costs, which the SKUs tab doesn't have).
function incompleteReasons(r: FinalCostingRow): string {
  // A gift kit has no RM lines and no fill weight, so rateGapReasons has nothing
  // to say and the vague fallback below would report "Possibly missing: RM cost"
  // — pointing at a rate master that can never fix it. A kit's gaps are about its
  // COMPONENTS, and they arrive already worded.
  if (r.kit) {
    if (r.kit.gaps.length > 0) return r.kit.gaps.join(" · ")
    // Every component priced, so whatever is wrong is on the kit's own PM side.
    return rateGapReasons(r).join(" · ") || "Possibly missing: PM cost"
  }

  const reasons = rateGapReasons(r)

  // Only fall back to the vague forms when the precise ones found nothing.
  if (reasons.length === 0) {
    if (r.rm_cost <= 0) reasons.push("RM cost")
    if (r.pm_cost <= 0) reasons.push("PM cost")
    if (reasons.length === 0) reasons.push("JW / Shrink / Shipper / Wastage %")
    return `Possibly missing: ${reasons.join(", ")}`
  }
  return reasons.join(" · ")
}

export default function FinalCostingTable({
  mfgId, rows, scenarios, breakups, bestIndex, search, total, page, pageSize,
}: {
  mfgId: number
  /** ONE PAGE of rows. Searched and sliced on the server — see the note in
   *  FinalCostingTabContent for why it cannot be done in the line query. */
  rows: FinalCostingRow[]
  /** The Analytics tab's three vendor-rate scenarios, each sliced alongside
   *  `rows` and therefore index-aligned with it. Shown inline when a SKU is expanded. */
  scenarios: { label: string; rows: FinalCostingComparisonRow[] }[]
  /** One per row, same index alignment — what the Actions column opens. */
  breakups: CostingBreakup[]
  /** Where the cheapest SKU sits ON THIS PAGE, or null when it is on another.
   *  Computed over every row, because "cheapest" is a fact about the
   *  manufacturer and a per-page winner would change on every page turn. */
  bestIndex: number | null
  search: string
  total: number
  page: number
  pageSize: number
}) {
  // Single-open, same shape as the invoice desk's history table — comparing one
  // SKU against the vendor rates is the question, not comparing two SKUs. The
  // panel is part of the state so the two expansions share one slot.
  const [open, setOpen] = useState<{ id: number; panel: Panel } | null>(null)

  // Still carries the index, because scenarios[].rows and breakups are read BY
  // POSITION — they were sliced with these rows and stay aligned.
  const visible = rows.map((r, i) => ({ r, i }))

  function show(id: number, panel: Panel) {
    setOpen(open?.id === id && open.panel === panel ? null : { id, panel })
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Total = RM + PM + (RM × RM Wastage%) + (PM × PM Wastage%) + JW + Shrink Wrap + Shipper. Rates from this manufacturer&apos;s agreed MRM rates. Click a SKU to compare it against the vendor rates, or Breakup for its RM/PM lines and misc costs.
        </p>
        {/* Only this table's own export lives here. The vendor-rate comparisons
            and their detailed-breakup export moved to the Analytics tab. */}
        <DownloadButton
          endpoint={`/api/v1/manufacturing/${mfgId}/final-costing/export`}
          label="Final Costing"
        />
      </div>
      {/* URL-driven: the search survives a reload, is shareable, and — the
          reason it moved off local state — reaches the server, so it searches
          every SKU rather than the page on screen. */}
      <UrlSearchInput initialValue={search} placeholder="Search SKU code or name…" />
      <Card>
        <CardContent className="p-0">
            <Table>
              <TableHeader>
                <CostingHeadRow actions />
              </TableHeader>
              <TableBody>
                <ScenarioLabelRow label="Agreed rate — this manufacturer (MRM)" colSpan={COL_COUNT} />
                {visible.length === 0 ? (
                  <TableEmpty
                    colSpan={COL_COUNT}
                    action={
                      rows.length === 0 ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/manufacturing/${mfgId}?tab=active`}>Add SKUs</Link>
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/manufacturing/${mfgId}?tab=final_costing`}>Clear search</Link>
                        </Button>
                      )
                    }
                  >
                    {rows.length === 0
                      ? "No active SKUs to cost yet — costing starts from the SKUs assigned to this manufacturer."
                      : `No SKU matches “${search.trim()}”.`}
                  </TableEmpty>
                ) : (
                  visible.map(({ r, i }) => {
                    const shown = open?.id === r.recipe_id ? open.panel : null
                    const toggleScenarios = () => show(r.recipe_id, "scenarios")
                    return (
                      <Fragment key={r.recipe_id}>
                        <TableRow className={shown ? "bg-muted/40" : undefined}>
                          <TableCell className="font-mono">
                            <span className="inline-flex items-center gap-1">
                              {r.incomplete && (
                                <span
                                  title={incompleteReasons(r)}
                                  className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] font-bold cursor-help"
                                >
                                  !
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={toggleScenarios}
                                aria-expanded={shown === "scenarios"}
                                className="inline-flex items-center gap-1 hover:underline"
                                title="Compare against approved / cheapest / priciest vendor rates"
                              >
                                {shown === "scenarios"
                                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                  : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                                {r.sku_code ?? "—"}
                              </button>
                            </span>
                          </TableCell>
                          <TableCell
                            onClick={toggleScenarios}
                            className="max-w-40 cursor-pointer truncate text-muted-foreground hover:underline"
                          >
                            {r.sku_name ?? "—"}
                          </TableCell>
                          <CostingCells row={r} best={i === bestIndex} />
                          <TableCell>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => show(r.recipe_id, "breakup")}
                              aria-expanded={shown === "breakup"}
                              title="RM / PM lines with their agreed rates, and this SKU's misc costs"
                            >
                              Breakup
                            </Button>
                          </TableCell>
                        </TableRow>
                        {/* The Analytics tab's three scenarios for this one SKU,
                            as their OWN table rather than more rows of this one.
                            Inline rows had to hold a placeholder column open on
                            every collapsed row just to stay aligned with them.

                            The MRM row is repeated as the first line so the panel
                            reads on its own: the whole question here is "cheaper
                            or dearer than our agreed rate", and the agreed rate
                            is otherwise scrolled off to the left in the parent. */}
                        {shown === "scenarios" && (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={COL_COUNT} className="px-3 py-2">
                              <div className="rounded-md border border-border bg-background">
                                <Table>
                                  <TableHeader>
                                    <ScenarioHeadRow />
                                  </TableHeader>
                                  <TableBody>
                                    <TableRow className="hover:bg-transparent">
                                      <TableCell className="text-[11px] font-medium">
                                        Agreed rate (MRM)
                                        <span className="ml-1 font-normal italic text-muted-foreground">baseline</span>
                                      </TableCell>
                                      <CostingCells row={r} best={false} />
                                    </TableRow>
                                    {scenarios.map((s) => (
                                      <TableRow key={s.label}>
                                        <TableCell className="text-[11px] text-muted-foreground">{s.label}</TableCell>
                                        <CostingCells row={s.rows[i]} best={false} />
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                        {shown === "breakup" && (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={COL_COUNT} className="px-3 py-2">
                              <CostingBreakupPanel breakup={breakups[i]} sku={r} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>
      <PaginationBar total={total} page={page} pageSize={pageSize} />
    </div>
  )
}
