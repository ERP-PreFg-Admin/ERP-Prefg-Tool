"use client"

// SKU × manufacturer open PO qty. Raw <table> for the same reason as MfgFacilityMatrix:
// the scrollbar is the affordance at this width, and border-separate keeps sticky cells opaque.

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { HEAD_BG, HEAD_ROW_LOOK } from "@/components/ui/table"
import { Card, CardContent } from "@/components/ui/card"
import { SearchInput } from "@/components/masters/SearchInput"
import { MasterToolbar, MasterToolbarActions } from "@/components/masters/MasterToolbar"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { cn } from "@/lib/utils"
import { OpenPoListDialog, type OpenPoTarget } from "./OpenPoListDialog"
import { OLD_PO_DAYS, buildOpenPoMatrix, matchesSku, type OpenPoCell } from "./overview-model"

const PAGE_SIZE = 25
// left-* offsets are the running sum of the frozen columns' widths.
const RANK_COL = "w-10 min-w-10"
const CODE_COL = "w-40 min-w-40 left-10"
const NAME_COL = "w-60 min-w-60 left-50"
const TOTAL_COL = "w-24 min-w-24 left-110"
const FROZEN_EDGE = "shadow-[1px_0_0_var(--color-border)]"

const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 })
const pos = (n: number) => `${n} PO${n === 1 ? "" : "s"}`

function OldDot() {
  return <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" aria-hidden />
}

export function OpenPosMatrix({ cells }: { cells: OpenPoCell[] }) {
  const { mfgs, skus } = useMemo(() => buildOpenPoMatrix(cells), [cells])
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [target, setTarget] = useState<OpenPoTarget | null>(null)

  const filtered = useMemo(() => skus.filter((s) => matchesSku(s, search)), [skus, search])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const start = (current - 1) * PAGE_SIZE
  const visible = filtered.slice(start, start + PAGE_SIZE)
  const oldTotal = mfgs.reduce((a, m) => a + m.oldPos, 0)

  return (
    <>
      <MasterToolbar>
        <SearchInput
          value={search}
          onChange={(v) => { setSearch(v); setPage(1) }}
          placeholder="Search SKU code or name"
        />
        <span className="text-xs text-muted-foreground">Ranked by total open PO qty</span>
        <MasterToolbarActions className="items-center gap-4">
          <span className="inline-flex items-center text-xs text-muted-foreground">
            <OldDot />Contains POs &gt; {OLD_PO_DAYS} days
          </span>
          <DownloadButton endpoint="/api/v1/manufacturing/open-pos/export" label="Open POs" extraParams={{ q: search }} disabled={skus.length === 0} />
        </MasterToolbarActions>
      </MasterToolbar>

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[70vh] overflow-auto rounded-t-lg">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead className={cn("sticky top-0 z-20", HEAD_BG)}>
                <tr className={cn(HEAD_ROW_LOOK, "[&>th]:align-bottom [&>th]:px-3 [&>th]:py-2")}>
                  <th className={cn("sticky left-0 z-20 text-left", HEAD_BG, RANK_COL)}>#</th>
                  <th className={cn("sticky z-20 text-left", HEAD_BG, CODE_COL)}>SKU Code</th>
                  <th className={cn("sticky z-20 text-left", HEAD_BG, NAME_COL)}>SKU Name</th>
                  <th className={cn("sticky z-20 text-right", HEAD_BG, TOTAL_COL, FROZEN_EDGE)}>Total Qty</th>
                  {mfgs.map((m) => (
                    <th key={m.id} className="min-w-36 text-right leading-tight">
                      <div className="font-medium text-foreground">{m.name}</div>
                      <div className="font-mono text-[10px] font-normal text-muted-foreground">{m.code}</div>
                    </th>
                  ))}
                </tr>
                {/* Kept in the sticky header so the >90-day count stays in view while scrolling. */}
                <tr className="[&>th]:border-t [&>th]:border-border [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-normal">
                  <th colSpan={3} className={cn("sticky left-0 z-20 text-left text-muted-foreground", HEAD_BG)}>
                    POs older than {OLD_PO_DAYS} days
                  </th>
                  <th className={cn("sticky z-20 text-right tabular-nums text-red-600 dark:text-red-400", HEAD_BG, TOTAL_COL, FROZEN_EDGE)}>
                    {oldTotal || "—"}
                  </th>
                  {mfgs.map((m) => (
                    <th key={m.id} className="text-right">
                      {m.oldPos > 0 ? (
                        <button
                          type="button"
                          onClick={() => setTarget({ mfgId: m.id, mfgName: m.name, olderThanDays: OLD_PO_DAYS })}
                          className="inline-flex items-center gap-0.5 rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400"
                          title={`${pos(m.oldPos)} at ${m.name} raised more than ${OLD_PO_DAYS} days ago`}
                        >
                          {pos(m.oldPos)} <ChevronRight className="h-3 w-3" />
                        </button>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={mfgs.length + 4} className="border-t border-border py-10 text-center text-muted-foreground">
                      {skus.length === 0 ? "No open POs." : "No SKUs match your search."}
                    </td>
                  </tr>
                ) : (
                  visible.map((s, i) => (
                    <tr key={s.sku_code} className="bg-background [&>td]:border-t [&>td]:border-border hover:bg-muted/40">
                      <td className={cn("sticky left-0 z-10 bg-inherit px-3 py-2 tabular-nums text-muted-foreground", RANK_COL)}>
                        {start + i + 1}
                      </td>
                      <td className={cn("sticky z-10 bg-inherit px-3 py-2 font-mono text-muted-foreground", CODE_COL)}>
                        {s.sku_code}
                      </td>
                      <td className={cn("sticky z-10 bg-inherit px-3 py-2 font-medium", NAME_COL)}>
                        <div className="truncate" title={s.sku_name ?? undefined}>{s.sku_name ?? "—"}</div>
                      </td>
                      <td className={cn("sticky z-10 bg-inherit px-3 py-2 text-right font-medium tabular-nums", TOTAL_COL, FROZEN_EDGE)}>
                        {fmt(s.total)}
                      </td>
                      {mfgs.map((m) => {
                        const c = s.cells[m.id]
                        if (!c) return <td key={m.id} className="px-3 py-2 text-right text-muted-foreground/40">—</td>
                        return (
                          <td key={m.id} className="p-0 text-right">
                            <button
                              type="button"
                              onClick={() => setTarget({ mfgId: m.id, mfgName: m.name, skuCode: s.sku_code, skuName: s.sku_name })}
                              className="w-full px-3 py-2 text-right hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              title={c.old_pos > 0 ? `${pos(c.old_pos)} older than ${OLD_PO_DAYS} days` : undefined}
                            >
                              <div className="font-medium tabular-nums">
                                {c.old_pos > 0 && <OldDot />}{fmt(c.open_qty)}
                              </div>
                              <div className="text-[11px] text-muted-foreground">{pos(c.open_pos)}</div>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              {filtered.length === 0 ? "0 SKUs" : `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} SKUs`}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}
                className="rounded p-1 hover:bg-accent disabled:opacity-40" aria-label="Previous page">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="tabular-nums">{current} / {pages}</span>
              <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}
                className="rounded p-1 hover:bg-accent disabled:opacity-40" aria-label="Next page">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <OpenPoListDialog target={target} onClose={() => setTarget(null)} />
    </>
  )
}
