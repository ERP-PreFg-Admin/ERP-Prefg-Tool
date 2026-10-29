"use client"

import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Columns3 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { HEAD_BG, TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { PaginationBar } from "@/components/ui/pagination-bar"
import { RecordCountHeader } from "@/components/masters/RecordCountHeader"
import { cn } from "@/lib/utils"
import { TRACE_BARS, TRACE_DATASETS, type TraceColumn, type TraceTab } from "@/lib/reports/trace/contracts"
import QtyBar from "./QtyBar"
import HopPanel from "./HopPanel"

// Value tones for the status-like columns: green = fine, amber = look at it, red = act on it.
const GOOD = new Set(["matched", "all_invoiced", "invoice", "exact", "nothing_received"])
const BAD = new Set(["billed_not_received", "received_not_billed", "data_error", "no_invoice", "unknown"])
const TONED = new Set(["status", "provenance", "source", "confidence", "batch_match"])
/** Flags where "yes" is a problem; `linked` is the reverse. */
const PROBLEM_FLAGS = new Set(["reverted", "sku_differs_from_po", "expiry_mismatch", "grn_unmatched_po", "short_dated"])

function tone(key: string, v: unknown): string {
  if (TONED.has(key) && typeof v === "string") {
    if (GOOD.has(v)) return "text-emerald-700 dark:text-emerald-400"
    if (BAD.has(v)) return "text-destructive font-medium"
    return "text-amber-700 dark:text-amber-400"
  }
  if (PROBLEM_FLAGS.has(key) && v === true) return "text-amber-700 dark:text-amber-400 font-medium"
  if (key === "linked" && v === false) return "text-destructive font-medium"
  return ""
}

function show(col: TraceColumn, v: unknown): string {
  if (v == null || v === "") return "—"
  if (col.type === "bool") return v ? "yes" : "no"
  if (col.type === "number") {
    const n = Number(v)
    return Number.isFinite(n) ? n.toLocaleString("en-IN", { maximumFractionDigits: 3 }) : String(v)
  }
  return String(v).replace(/_/g, TONED.has(col.key) ? " " : "_")
}

// Procurement PO numbers drill to FG PO Tracking (which lists no inward POs, so those stay plain).
const PO_KEYS = new Set(["po_no", "master_po_no"])

// SKU code and name stay pinned on the left while the rest scrolls; widths are fixed so the offsets add up.
const PIN_W: Record<string, number> = { sku_code: 150, sku_name: 240 }
const TOGGLE_W = 28
const BAR_W = 200
const colWidth = (c: TraceColumn) => PIN_W[c.key] ?? (c.type === "number" ? 120 : c.type === "bool" ? 90 : 170)
const PIN_BG = "bg-background group-hover:bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))]"

const storageKey = (tab: TraceTab) => `trace-cols:${tab}`
function readChosen(tab: TraceTab): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey(tab))
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    return null
  }
}

export default function TraceTable({ tab, rows, pagination, emptyText = "No rows for these filters.", chooser = false, expand = false }: {
  tab: TraceTab
  rows: Record<string, unknown>[]
  pagination?: { total: number; page: number; pageSize: number }
  emptyText?: string
  /** Show the column picker (remembered per dataset in this browser). */
  chooser?: boolean
  /** Each row gets a toggle that loads its next hop (lib/reports/trace/hops.ts) below it. */
  expand?: boolean
}) {
  const renderExpanded = expand ? (row: Record<string, unknown>) => <HopPanel tab={tab} row={row} /> : undefined
  const all = TRACE_DATASETS[tab].columns
  const defaults = useMemo(() => all.filter((c) => c.screen).map((c) => c.key), [all])
  const [chosen, setChosen] = useState<string[]>(defaults)
  const [picking, setPicking] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const headRef = useRef<HTMLDivElement>(null)

  // eslint-disable-next-line react-hooks/set-state-in-effect -- the saved choice lives in localStorage, readable only after mount
  useEffect(() => { if (chooser) setChosen(readChosen(tab) ?? defaults) }, [chooser, tab, defaults])

  const save = (keys: string[]) => {
    setChosen(keys)
    try { localStorage.setItem(storageKey(tab), JSON.stringify(keys)) } catch { /* private mode: keep in memory */ }
  }
  const picked = all.filter((c) => chosen.includes(c.key))
  const columns = [...picked.filter((c) => c.key in PIN_W), ...picked.filter((c) => !(c.key in PIN_W))]
  const pinned = columns.filter((c) => c.key in PIN_W)
  const pinLeft = (key: string) => {
    let left = expand ? TOGGLE_W : 0
    for (const c of pinned) { if (c.key === key) break; left += PIN_W[c.key] }
    return left
  }
  const lastPin = pinned.at(-1)?.key
  const bar = TRACE_BARS[tab]
  const span = columns.length + (bar ? 1 : 0) + (renderExpanded ? 1 : 0)
  const toggle = (i: number) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })

  // Header and body are two tables on one set of widths: the header sticks to the page, the body scrolls sideways.
  const widths = [...(renderExpanded ? [TOGGLE_W] : []), ...columns.map(colWidth), ...(bar ? [BAR_W] : [])]
  const minWidth = widths.reduce((a, b) => a + b, 0)
  const cols = <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
  const tableClass = "w-full table-fixed border-separate border-spacing-0 text-sm"
  const pinClass = (key: string) => cn("sticky z-10", key === lastPin && "shadow-[1px_0_0_var(--color-border)]")

  return (
    <>
      {chooser && (
        <div className="relative mb-2 flex justify-end">
          <button type="button" onClick={() => setPicking((p) => !p)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs hover:bg-accent">
            <Columns3 className="h-3.5 w-3.5" /> Columns ({columns.length}/{all.length})
          </button>
          {picking && (
            <div className="absolute right-0 top-9 z-30 max-h-96 w-72 overflow-auto rounded-md border bg-popover p-2 shadow-md">
              <div className="mb-1 flex justify-between text-[11px]">
                <button type="button" className="text-primary hover:underline" onClick={() => save(all.map((c) => c.key))}>All</button>
                <button type="button" className="text-primary hover:underline" onClick={() => save(defaults)}>Default</button>
              </div>
              {all.map((c) => (
                <label key={c.key} className="flex items-center gap-2 py-0.5 text-xs">
                  <input type="checkbox" checked={chosen.includes(c.key)}
                    onChange={(e) => save(e.target.checked ? [...chosen, c.key] : chosen.filter((k) => k !== c.key))} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <Card>
        {pagination && <RecordCountHeader total={pagination.total} />}
        <CardContent className="p-0">
          <div ref={headRef} className="sticky top-0 z-20 overflow-hidden border-b">
            <table className={tableClass} style={{ minWidth }}>
              {cols}
              <thead>
                <tr>
                  {renderExpanded && <TableHead className={cn("sticky left-0 z-10 px-1", HEAD_BG)} />}
                  {columns.map((c) => (
                    <TableHead key={c.key} title={c.label} style={c.key in PIN_W ? { left: pinLeft(c.key) } : undefined}
                      className={cn("truncate", c.type === "number" && "text-right", c.key in PIN_W && pinClass(c.key))}>
                      {c.label}
                    </TableHead>
                  ))}
                  {bar && <TableHead>Progress</TableHead>}
                </tr>
              </thead>
            </table>
          </div>
          <div className="overflow-x-auto" onScroll={(e) => { if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft }}>
            <table className={tableClass} style={{ minWidth }}>
              {cols}
              <TableBody>
                {rows.length === 0 ? (
                  <TableEmpty colSpan={span}>{emptyText}</TableEmpty>
                ) : rows.map((r, i) => (
                  <Fragment key={i}>
                    <TableRow className="group">
                      {renderExpanded && (
                        <TableCell className={cn("sticky left-0 z-10 px-1", PIN_BG)}>
                          <button type="button" onClick={() => toggle(i)} aria-expanded={open.has(i)}
                            aria-label={open.has(i) ? "Collapse" : "Expand to the next hop"}
                            className="h-5 w-5 rounded text-muted-foreground hover:bg-accent">{open.has(i) ? "▾" : "▸"}</button>
                        </TableCell>
                      )}
                      {columns.map((c) => {
                        const v = r[c.key]
                        const text = show(c, v)
                        const pin = c.key in PIN_W
                        return (
                          <TableCell key={c.key} title={text} style={pin ? { left: pinLeft(c.key) } : undefined}
                            className={cn("truncate whitespace-nowrap text-[13px]", c.type === "number" && "text-right tabular-nums", tone(c.key, v),
                              pin && cn(pinClass(c.key), PIN_BG), c.key === "sku_code" && "font-mono font-medium")}>
                            {PO_KEYS.has(c.key) && v
                              ? <Link href={`/po-tracking/po-procurement?search=${encodeURIComponent(String(v))}`} className="font-mono hover:underline">{text}</Link>
                              : text}
                          </TableCell>
                        )
                      })}
                      {bar && (
                        <TableCell>
                          <QtyBar total={Number(r[bar.total] ?? 0)}
                            parts={bar.parts.map((p) => ({ label: p.label, tone: p.tone, value: Number(r[p.key] ?? 0) }))} />
                        </TableCell>
                      )}
                    </TableRow>
                    {renderExpanded && open.has(i) && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={span} className="p-3">{renderExpanded(r)}</TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>
      {pagination && <PaginationBar total={pagination.total} page={pagination.page} pageSize={pagination.pageSize} />}
    </>
  )
}
