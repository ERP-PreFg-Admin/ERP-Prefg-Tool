"use client"

import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { cn } from "@/lib/utils"
import { poOptionsFor, type Row } from "./invoice-form"
import type { OpenPoOption } from "@/types/invoice"
import type { SkuOption } from "../po-procurement/po-types"

const cellCls =
  "w-full rounded border border-input bg-background px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
/** Highlights a cell the user still has to deal with. */
const warnCls = "border-amber-400 bg-amber-50 dark:bg-amber-950/30"

/** The plain numeric columns, which differ only by which field they bind to. */
const NUMERIC_FIELDS = ["rate", "mrp", "discount", "gst_percent", "amount", "total_amount"] as const

export function InvoiceLineItems({
  rows, setRow, addRow, removeRow, skuOptions, openPos, mfgId,
}: {
  rows: Row[]
  setRow: (i: number, field: keyof Row, value: string) => void
  addRow: () => void
  removeRow: (i: number) => void
  skuOptions: SkuOption[]
  openPos: OpenPoOption[]
  mfgId: string
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Line Items <span className="text-destructive">*</span></Label>
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-3 w-3" /> Add row
        </Button>
      </div>

      <div className="max-h-[46vh] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-320 text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="[&>th]:whitespace-nowrap [&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium [&>th]:text-muted-foreground">
              <th className="min-w-56">SKU *</th>
              <th className="min-w-56">Reference PO</th>
              <th className="min-w-48">Product Name</th>
              <th className="min-w-28">Batch</th>
              <th className="min-w-24">Mfg Date</th>
              <th className="min-w-24">Expiry</th>
              <th className="min-w-24">HSN</th>
              <th className="min-w-24">Qty *</th>
              <th className="min-w-24">Rate</th>
              <th className="min-w-24">MRP</th>
              <th className="min-w-24">Disc.</th>
              <th className="min-w-20">GST %</th>
              <th className="min-w-28">Amount</th>
              <th className="min-w-28">Line Total</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={15} className="px-2 py-6 text-center text-muted-foreground">
                  No line items were read. Add rows manually.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border align-top [&>td]:px-1.5 [&>td]:py-1.5">
                <td>
                  <FuzzySelect
                    options={skuOptions}
                    value={r.sku_code}
                    onChange={(v) => setRow(i, "sku_code", v)}
                    getValue={(o) => o.sku_code}
                    getLabel={(o) => `${o.sku_code} — ${o.name}`}
                    searchKeys={["sku_code", "name"]}
                    placeholder="Map to a SKU…"
                    // A referenced line is received against a PO by id, so it
                    // doesn't need a SKU and shouldn't be flagged for missing one.
                    className={cn("text-xs", !r.sku_code && !r.reference_po_id && warnCls)}
                  />
                  {r.parsed_code && r.parsed_code !== r.sku_code && (
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={r.parsed_code}>
                      invoice: {r.parsed_code}
                    </p>
                  )}
                </td>

                <td>
                  {!mfgId ? (
                    <span className="text-[11px] text-muted-foreground">Pick a manufacturer first</span>
                  ) : openPos.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">No open POs</span>
                  ) : (
                    <>
                      <FuzzySelect
                        options={poOptionsFor(openPos, r.sku_code)}
                        value={r.reference_po_id}
                        onChange={(v) => setRow(i, "reference_po_id", v)}
                        getValue={(o) => String(o.id)}
                        getLabel={(o) => `${o.po_no} — ${o.sku_code ?? "—"} · ${Number(o.remaining)} left`}
                        searchKeys={["po_no", "sku_code", "sku_name"]}
                        placeholder="Receive against…"
                        className="text-xs"
                      />
                      {r.reference_po_id && (
                        <button
                          onClick={() => setRow(i, "reference_po_id", "")}
                          className="mt-0.5 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          clear — create a new PO instead
                        </button>
                      )}
                    </>
                  )}
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
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
