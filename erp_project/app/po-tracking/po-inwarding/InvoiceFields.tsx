"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { InvoiceForm } from "./invoice-form"
import type { MfgOption, WarehouseOption } from "../po-procurement/po-types"

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
const textareaCls =
  "w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"

type SetField = <K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) => void

/** Label + Input bound to one form field — the shape most of this form is. */
function Field({
  label, value, onChange, type, placeholder, required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">
        {label}{required && <span className="text-destructive"> *</span>}
      </Label>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 text-sm"
      />
    </div>
  )
}

/** What the extractor read for a field the user is now overriding via a picker. */
function ParsedHint({ value }: { value: string }) {
  if (!value) return null
  return <p className="text-[11px] text-muted-foreground">Invoice says: <strong>{value}</strong></p>
}

export function InvoiceFields({
  form, setField, onChangeMfg, mfgOptions, warehouseOptions, lineSum, extra, setExtra,
}: {
  form: InvoiceForm
  setField: SetField
  /** Separate from setField: switching manufacturer also invalidates the
   *  reference-PO list and any references already picked from it. */
  onChangeMfg: (value: string) => void
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  lineSum: number
  extra: Record<string, string>
  setExtra: (next: Record<string, string>) => void
}) {
  const [showExtra, setShowExtra] = useState(false)
  const extraKeys = Object.keys(extra)

  return (
    <>
      {/* Header */}
      <section className="grid grid-cols-2 gap-3">
        <Field label="Invoice No" required value={form.invoiceNo} onChange={(v) => setField("invoiceNo", v)} />
        <Field label="Invoice Date" type="date" value={form.invoiceDate} onChange={(v) => setField("invoiceDate", v)} />
        <Field label="Currency" value={form.currency} onChange={(v) => setField("currency", v)} />
        <Field label="Purchase Order Ref" placeholder="—" value={form.poRef} onChange={(v) => setField("poRef", v)} />
        <Field label="E-way Bill No" value={form.ewayBill} onChange={(v) => setField("ewayBill", v)} />
        <Field label="Vehicle No" value={form.vehicleNo} onChange={(v) => setField("vehicleNo", v)} />
      </section>

      {/* Parties */}
      <section className="grid gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Manufacturer <span className="text-destructive">*</span></Label>
          <select value={form.mfgId} onChange={(e) => onChangeMfg(e.target.value)} className={selectCls}>
            <option value="">— Select MFG —</option>
            {mfgOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
            ))}
          </select>
          <ParsedHint value={form.parsedFrom} />
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs">Destination <span className="text-destructive">*</span></Label>
          <select
            value={form.destination}
            onChange={(e) => setField("destination", e.target.value)}
            className={selectCls}
          >
            <option value="">— Select Warehouse —</option>
            {warehouseOptions.map((w) => (
              <option key={w.id} value={w.name}>
                {w.name}{w.zone ? ` — ${w.zone}` : ""} ({w.type})
              </option>
            ))}
          </select>
          <ParsedHint value={form.parsedDest} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Seller GSTIN" value={form.sellerGstin} onChange={(v) => setField("sellerGstin", v)} />
          <Field label="Buyer GSTIN" value={form.buyerGstin} onChange={(v) => setField("buyerGstin", v)} />
        </div>
      </section>

      {/* Bill to / Ship to — separate blocks on the invoice, and on a stock
          transfer they're different addresses for one company. */}
      <section className="grid gap-3 rounded-lg border border-border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bill To — Name" placeholder="—" value={form.billToName} onChange={(v) => setField("billToName", v)} />
          <Field label="Bill To — State" placeholder="—" value={form.billToState} onChange={(v) => setField("billToState", v)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Bill To — Address</Label>
          <textarea
            value={form.billToAddress}
            onChange={(e) => setField("billToAddress", e.target.value)}
            rows={2} placeholder="—" className={textareaCls}
          />
        </div>
        <Field label="Ship To — Name" placeholder="—" value={form.shipToName} onChange={(v) => setField("shipToName", v)} />
        <div className="grid gap-1.5">
          <Label className="text-xs">Ship To — Address</Label>
          <textarea
            value={form.shipToAddress}
            onChange={(e) => setField("shipToAddress", e.target.value)}
            rows={2} placeholder="—" className={textareaCls}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Captured from the invoice for reference. Not stored on the PO — the
          Destination above is what drives inwarding.
        </p>
      </section>

      {/* Totals — the sum sits next to the parsed total so a mismatch is visible */}
      <section className="grid grid-cols-2 gap-3">
        <Field label="Invoice Total" type="number" value={form.invoiceTotal} onChange={(v) => setField("invoiceTotal", v)} />
        <div className="grid gap-1.5">
          <Label className="text-xs">Sum of line items</Label>
          <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm tabular-nums text-muted-foreground">
            {lineSum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </div>
        </div>
      </section>

      {/* Anything the parser returned that isn't modelled above */}
      {extraKeys.length > 0 && (
        <section className="grid gap-2">
          <button
            onClick={() => setShowExtra((v) => !v)}
            className="text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {showExtra ? "▾" : "▸"} Other parsed fields ({extraKeys.length})
          </button>
          {showExtra && (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              {extraKeys.map((k) => (
                <div key={k} className="grid gap-1">
                  <Label className="text-[11px] text-muted-foreground">{k.replace(/_/g, " ")}</Label>
                  <input
                    className="w-full rounded border border-input bg-background px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    value={extra[k]}
                    onChange={(e) => setExtra({ ...extra, [k]: e.target.value })}
                  />
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Shown so nothing is lost from the parse. These aren&apos;t stored on the PO.
              </p>
            </div>
          )}
        </section>
      )}
    </>
  )
}
