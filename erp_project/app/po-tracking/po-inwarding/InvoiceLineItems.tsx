"use client"

import { useMemo } from "react"
import { AlertTriangle, Check, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TableEmpty } from "@/components/ui/empty-state"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"
import { SectionHead } from "./InvoiceFields"
import { bomBySku, poOptionsFor, type Row } from "./invoice-form"
import type { OpenPoOption } from "@/types/invoice"
import type { SkuOption } from "../po-procurement/po-types"

const cellCls =
  "w-full rounded border border-input bg-background px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
/** Highlights a cell the user still has to deal with. */
const warnCls = "border-amber-400 bg-amber-50 dark:bg-amber-950/30"

/** The plain numeric columns, which differ only by which field they bind to.
 *
 *  `mrp` and `discount` are deliberately absent: they're still parsed from the
 *  invoice, still submitted, and still written to invoice_items_mfg (and
 *  mrp still reaches Uniware as maxRetailPrice — see lib/invoice-inward.ts).
 *  They're just not editable here. Add them back to this list to restore both
 *  the header cells and the inputs. */
const NUMERIC_FIELDS = ["rate", "gst_percent", "amount", "total_amount"] as const

export function InvoiceLineItems({
  rows, setRow, addRow, removeRow, rematch, skuOptions, openPos, mfgId,
}: {
  rows: Row[]
  setRow: (i: number, field: keyof Row, value: string) => void
  addRow: () => void
  removeRow: (i: number) => void
  /** Re-run the FIFO allocation. Needed after a SKU or quantity edit — the match
   *  isn't recomputed on every keystroke, which would shred rows mid-typing. */
  rematch: () => void
  skuOptions: SkuOption[]
  openPos: OpenPoOption[]
  mfgId: string
}) {
  const poById = useMemo(() => new Map(openPos.map((p) => [String(p.id), p])), [openPos])
  const bomInfo = useMemo(() => bomBySku(openPos), [openPos])

  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-3">
        <SectionHead>{`Line items (${rows.length})`}</SectionHead>
        <Button variant="outline" size="sm" className="shrink-0" onClick={addRow}>
          <Plus className="h-3 w-3" /> Add row
        </Button>
        <Button
          variant="outline" size="sm" className="shrink-0"
          onClick={rematch}
          disabled={!mfgId}
          title="Match every line against the oldest open POs first"
        >
          <RefreshCw className="h-3 w-3" /> Re-match POs (FIFO)
        </Button>
      </div>

      <div className="max-h-[46vh] overflow-auto rounded-lg border border-border">
        {/* border-separate: with the preflight's border-collapse, a sticky cell is
            painted in the table's background layer and the scrolling columns' text
            draws right over the frozen one. Row borders move to the cells. */}
        <table className="w-full min-w-320 border-separate border-spacing-0 text-xs">
          {/* z-20, not z-10: the frozen first column below sits at z-10 and would
              otherwise paint over the header it scrolls past. */}
          <thead className="sticky top-0 z-20 bg-muted">
            <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
              {/* Frozen: the SKU picker stays pinned while the other 14 columns
                  scroll under it. Needs its own opaque background — the thead's
                  sits behind it, not on it. */}
              <th className="min-w-56 sticky left-0 bg-muted shadow-[1px_0_0_var(--color-border)]">SKU *</th>
              <th className="min-w-56">Reference PO *</th>
              <th className="min-w-32">Recipe Code</th>
              <th className="min-w-48">Product Name</th>
              <th className="min-w-28">Batch</th>
              <th className="min-w-24">Mfg Date</th>
              <th className="min-w-24">Expiry</th>
              <th className="min-w-24">HSN</th>
              <th className="min-w-24">Qty *</th>
              <th className="min-w-24">Rate</th>
              <th className="min-w-20">GST %</th>
              <th className="min-w-28">Amount</th>
              <th className="min-w-28">Line Total</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <TableEmpty
                colSpan={14}
                className="py-6"
                action={
                  <Button variant="outline" size="sm" onClick={addRow}>
                    <Plus /> Add row
                  </Button>
                }
              >
                No line items were read from this invoice.
              </TableEmpty>
            )}
            {rows.map((r, i) => {
              const bom = bomInfo.get(r.sku_code.trim().toLowerCase())
              // The only case the desk still picks a PO by hand: two Recipe versions
              // of this product are live at once and nothing on the PO records
              // which one it was raised against. Everywhere else the FIFO match
              // decides, and showing a picker would only invite it to be undone.
              const needsChoice = (bom?.count ?? 0) > 1
              const refPo = poById.get(r.reference_po_id)

              return (
              <tr key={i} className="bg-background align-top [&>td]:border-t [&>td]:border-border [&>td]:px-1.5 [&>td]:py-1.5">
                <td className="sticky left-0 z-10 bg-inherit shadow-[1px_0_0_var(--color-border)]">
                  <FuzzySelect
                    options={skuOptions}
                    value={r.sku_code}
                    onChange={(v) => setRow(i, "sku_code", v)}
                    getValue={(o) => o.sku_code}
                    getLabel={(o) => `${o.sku_code} — ${o.name}`}
                    searchKeys={["sku_code", "name"]}
                    placeholder="Map to a SKU…"
                    className={cn("text-xs", !r.sku_code && warnCls)}
                  />
                  {/* Say so when the mapping worked, not only when it didn't —
                      a silent field looks the same as an unchecked one. */}
                  {r.parsed_code && r.parsed_code !== r.sku_code && (
                    <p
                      className={cn(
                        "mt-0.5 flex items-center gap-1 truncate text-[10px]",
                        r.sku_code ? "text-emerald-700 dark:text-emerald-500" : "text-amber-700 dark:text-amber-500"
                      )}
                      title={r.parsed_code}
                    >
                      {r.sku_code
                        ? <><Check className="h-3 w-3 shrink-0" /> matched from “{r.parsed_code}”</>
                        : <><AlertTriangle className="h-3 w-3 shrink-0" /> no match for “{r.parsed_code}”</>}
                    </p>
                  )}
                </td>

                <td>
                  {!mfgId ? (
                    <span className="text-[11px] text-muted-foreground">Pick a manufacturer first</span>
                  ) : needsChoice ? (
                    <>
                      <FuzzySelect
                        options={poOptionsFor(openPos, r.sku_code)}
                        value={r.reference_po_id}
                        onChange={(v) => setRow(i, "reference_po_id", v)}
                        getValue={(o) => String(o.id)}
                        getLabel={(o) => `${o.po_no} — ${Number(o.remaining)} left`}
                        searchKeys={["po_no", "sku_code", "sku_name"]}
                        placeholder="Pick the PO…"
                        className={cn("text-xs", !r.reference_po_id && warnCls)}
                      />
                      <p className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-500">
                        {bom?.count} Recipe versions live — pick the right PO
                      </p>
                    </>
                  ) : refPo ? (
                    // Assigned by the FIFO match, not chosen: read-only, with the
                    // reason it won stated so it isn't a black box.
                    <div className="flex items-start gap-1 py-1 text-[11px] text-emerald-700 dark:text-emerald-500">
                      <Check className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        <span className="font-medium">{refPo.po_no}</span>
                        <span className="block text-[10px] text-muted-foreground">
                          oldest open PO{refPo.date ? ` · raised ${String(refPo.date).slice(0, 10)}` : ""}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1 py-1 text-[11px] text-amber-700 dark:text-amber-500">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        {openPos.length === 0 ? "No open POs" : "No open PO left to cover this"}
                      </span>
                    </div>
                  )}
                </td>

                {/* Read-only: the Recipe(s) live for this line's SKU, so the desk can
                    see which recipe the goods are being booked against. */}
                <td className="px-1.5 py-2 font-mono text-[11px] text-muted-foreground">
                  {bom?.codes ?? "—"}
                </td>

                <td><input className={cellCls} value={r.sku_name} onChange={(e) => setRow(i, "sku_name", e.target.value)} /></td>
                <td><input className={cellCls} value={r.batch}    onChange={(e) => setRow(i, "batch", e.target.value)} /></td>
                {/* Text, not <input type="date">: invoices routinely print these
                    month-only ("Jun-2026"), which a date input can't represent. */}
                <td><input className={cellCls} value={r.mfg_date} onChange={(e) => setRow(i, "mfg_date", e.target.value)} /></td>
                <td><input className={cellCls} value={r.expiry}   onChange={(e) => setRow(i, "expiry", e.target.value)} /></td>
                <td><input className={cellCls} value={r.hsn}      onChange={(e) => setRow(i, "hsn", e.target.value)} /></td>

                <td>
                  <input
                    type="number" min={0}
                    className={cn(cellCls, "text-right", !(Number(r.qty) > 0) && warnCls)}
                    value={r.qty} onChange={(e) => setRow(i, "qty", e.target.value)}
                  />
                </td>

                {NUMERIC_FIELDS.map((field) => (
                  <td key={field}>
                    <input
                      type="number"
                      className={cn(cellCls, "text-right")}
                      value={r[field]}
                      onChange={(e) => setRow(i, field, e.target.value)}
                    />
                  </td>
                ))}

                <td>
                  <button
                    onClick={() => removeRow(i)}
                    title="Remove row"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
