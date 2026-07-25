"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toast"
import type { MfgOption, WarehouseOption } from "./po-types"
import { useQuotedRate } from "./useQuotedRate"

type PoType = "normal" | "impromptu"

type MfgSkuOption = { sku_code: string; sku_name: string }

type PoLineRowState = {
  sku_code: string
  sku_name: string
  qty: string
  expected_on: string
  destination: string
}

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"

// One SKU row — the quoted rate is fetched independently per row (display
// only; submission re-fetches it fresh right before creating each PO, so a
// stale/failed display here never blocks the other rows).
function PoLineRow({
  row, mfgId, today, warehouseOptions, error, onChange, onRemove,
}: {
  row: PoLineRowState
  mfgId: string
  today: string
  warehouseOptions: WarehouseOption[]
  error?: string
  onChange: (field: keyof PoLineRowState, value: string) => void
  onRemove: () => void
}) {
  const { rate, loading: rateLoading } = useQuotedRate(row.sku_code, mfgId)

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-2 py-1.5 align-top">
        <div className="font-mono text-xs font-medium">{row.sku_code}</div>
        <div className="text-[11px] text-muted-foreground max-w-40 truncate">{row.sku_name}</div>
      </td>
      <td className="px-2 py-1.5 align-top">
        <Input
          type="number" min={0} placeholder="0" value={row.qty}
          onChange={(e) => onChange("qty", e.target.value)}
          className="h-8 w-24 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 align-top whitespace-nowrap text-xs text-muted-foreground">
        {rateLoading ? "Calculating…" : rate != null ? `₹${rate.toFixed(2)}` : "—"}
      </td>
      <td className="px-2 py-1.5 align-top">
        <Input
          type="date" min={today} value={row.expected_on}
          onChange={(e) => onChange("expected_on", e.target.value)}
          className="h-8 w-36 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        <select
          value={row.destination}
          onChange={(e) => onChange("destination", e.target.value)}
          className={selectCls}
        >
          <option value="">— Select —</option>
          {warehouseOptions.map((w) => (
            <option key={w.id} value={w.name}>
              {w.name}{w.zone ? ` — ${w.zone}` : ""} ({w.type})
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5 align-top">
        {error && <p className="text-[11px] text-destructive max-w-32">{error}</p>}
      </td>
      <td className="px-2 py-1.5 align-top">
        <button
          type="button"
          onClick={onRemove}
          title="Remove this SKU from the list"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}

export default function AddPODialog({
  open, onClose, mfgOptions, warehouseOptions, onCreated,
}: {
  open: boolean
  onClose: () => void
  mfgOptions: MfgOption[]
  warehouseOptions: WarehouseOption[]
  onCreated: () => void
}) {
  const [poType, setPoType]         = useState<PoType>("normal")
  const [mfgId, setMfgId]           = useState("")
  const [rows, setRows]             = useState<PoLineRowState[]>([])
  const [loadingSkus, setLoadingSkus] = useState(false)
  const [skusError, setSkusError]   = useState("")
  const [reason, setReason]         = useState("")
  const [rowErrors, setRowErrors]   = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError]     = useState("")
  const { toast } = useToast()

  const today = new Date().toISOString().slice(0, 10)
  const defaultDest =
    warehouseOptions.find((w) => w.name.toLowerCase().includes("mumbai"))?.name
    ?? warehouseOptions.find((w) => w.type === "MWH")?.name
    ?? ""

  useEffect(() => {
    if (open) {
      setPoType("normal")
      setMfgId("")
      setRows([])
      setReason("")
      setRowErrors({})
      setApiError("")
      setSkusError("")
    }
  }, [open])

  useEffect(() => {
    if (!open || !mfgId) { setRows([]); return }
    setLoadingSkus(true)
    setSkusError("")
    setRowErrors({})
    fetch(`/api/purchase-orders/mfg-skus?mfg_id=${mfgId}`)
      .then((r) => r.json())
      .then((data: { skus?: MfgSkuOption[] }) => {
        setRows(
          (data.skus ?? []).map((s) => ({
            sku_code: s.sku_code,
            sku_name: s.sku_name,
            qty: "",
            expected_on: "",
            destination: defaultDest,
          }))
        )
      })
      .catch(() => setSkusError("Failed to load SKUs for this manufacturer."))
      .finally(() => setLoadingSkus(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mfgId])

  function setRowField(sku_code: string, field: keyof PoLineRowState, value: string) {
    setRows((prev) => prev.map((r) => (r.sku_code === sku_code ? { ...r, [field]: value } : r)))
    setRowErrors((e) => ({ ...e, [sku_code]: "" }))
    setApiError("")
  }

  async function handleSubmit() {
    setApiError("")
    if (!mfgId) { setApiError("Select a manufacturer."); return }

    const filled = rows.filter((r) => Number(r.qty) > 0)
    if (filled.length === 0) { setApiError("Enter a quantity for at least one SKU."); return }

    if (poType === "impromptu" && !reason.trim()) {
      setApiError("Remarks are required for Impromptu POs.")
      return
    }

    const errs: Record<string, string> = {}
    for (const r of filled) {
      if (!r.expected_on) errs[r.sku_code] = "Expected dispatch date is required."
      else if (r.expected_on < today) errs[r.sku_code] = "Backdating is not allowed."
    }
    if (Object.keys(errs).length > 0) { setRowErrors(errs); return }

    setSubmitting(true)
    const outcomes: { sku_code: string; ok: boolean; message: string }[] = []

    for (const r of filled) {
      try {
        const rateRes = await fetch(
          `/api/purchase-orders/quote-rate?sku_code=${encodeURIComponent(r.sku_code)}&mfg_id=${mfgId}`
        )
        const rateData = await rateRes.json()
        if (!rateRes.ok || rateData.rate == null) {
          outcomes.push({ sku_code: r.sku_code, ok: false, message: rateData.error ?? "Rate unavailable." })
          continue
        }
        const unitPrice = rateData.rate as number
        const totalAmt  = unitPrice * Number(r.qty)

        const res = await fetch("/api/purchase-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            po_type:      poType,
            mfg_id:       Number(mfgId),
            sku_code:     r.sku_code,
            qty:          Number(r.qty),
            unit_price:   unitPrice,
            total_amount: totalAmt,
            expected_on:  r.expected_on,
            destination:  r.destination || undefined,
            reason:       reason.trim() || undefined,
          }),
        })
        const data = await res.json()
        if (!res.ok) { outcomes.push({ sku_code: r.sku_code, ok: false, message: data.error ?? "Failed to create PO." }); continue }
        outcomes.push({ sku_code: r.sku_code, ok: true, message: data.po_no ?? "Created" })
      } catch {
        outcomes.push({ sku_code: r.sku_code, ok: false, message: "Network error." })
      }
    }
    setSubmitting(false)

    const succeeded = outcomes.filter((o) => o.ok)
    const failed    = outcomes.filter((o) => !o.ok)

    if (failed.length === 0) {
      toast({
        title: poType === "normal" ? "POs raised" : "Submitted for approval",
        description: `${succeeded.length} PO${succeeded.length !== 1 ? "s" : ""} created.`,
        variant: "success",
      })
      onCreated()
      onClose()
      return
    }

    // Partial failure — clear the successful rows' quantities, keep the
    // dialog open with per-row errors on the failed ones so the user can fix
    // and retry just those instead of resubmitting everything.
    setRows((prev) => prev.map((r) => {
      const o = outcomes.find((x) => x.sku_code === r.sku_code)
      return o?.ok ? { ...r, qty: "" } : r
    }))
    const errMap: Record<string, string> = {}
    for (const f of failed) errMap[f.sku_code] = f.message
    setRowErrors(errMap)
    setApiError(
      `${succeeded.length} PO${succeeded.length !== 1 ? "s" : ""} created, ${failed.length} failed — see errors below.`
    )
    if (succeeded.length > 0) onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Purchase Order</DialogTitle>
          <p className="text-xs text-muted-foreground pt-1">
            {poType === "normal"
              ? "Normal POs are raised immediately — no approval needed."
              : "Impromptu POs are submitted for approval before being raised."}
          </p>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {/* Manufacturer — selected first; SKUs load once picked */}
          <div className="grid gap-1.5">
            <Label htmlFor="apo-mfg">Manufacturer <span className="text-destructive">*</span></Label>
            <select
              id="apo-mfg" value={mfgId}
              onChange={(e) => setMfgId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— Select MFG —</option>
              {mfgOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
              ))}
            </select>
          </div>

          {/* SKU rows — one line per SKU: qty, rate, dispatch, destination */}
          {!mfgId ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Select a manufacturer to see the SKUs it produces.
            </p>
          ) : loadingSkus ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Loading SKUs…</p>
          ) : skusError ? (
            <p className="text-xs text-destructive py-4 text-center">{skusError}</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              This manufacturer has no active SKUs to order.
            </p>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">SKU</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">PO Qty</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Rate / Unit</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Expected Dispatch</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Destination WH</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground"></th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <PoLineRow
                      key={r.sku_code}
                      row={r}
                      mfgId={mfgId}
                      today={today}
                      warehouseOptions={warehouseOptions}
                      error={rowErrors[r.sku_code]}
                      onChange={(field, value) => setRowField(r.sku_code, field, value)}
                      onRemove={() => setRows((prev) => prev.filter((x) => x.sku_code !== r.sku_code))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Reason — mandatory only for Impromptu, applies to the whole batch */}
          <div className="grid gap-1.5">
            <Label htmlFor="apo-reason">
              Reason / Notes
              {poType === "impromptu" && <span className="text-destructive"> *</span>}
            </Label>
            <Textarea
              id="apo-reason" rows={2}
              placeholder="Why are these POs being raised? Any special instructions…"
              value={reason} onChange={(e) => setReason(e.target.value)}
            />
          </div>

          {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        </div>

        <DialogFooter className="flex-row items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={poType === "impromptu"}
              onChange={(e) => setPoType(e.target.checked ? "impromptu" : "normal")}
              className="h-3.5 w-3.5 rounded accent-amber-500"
            />
            <span className="text-xs text-muted-foreground">
              Impromptu{poType === "impromptu" && <span className="ml-1 font-mono opacity-60">(IMP-)</span>}
            </span>
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting || !mfgId}>
              {submitting
                ? (poType === "normal" ? "Raising…" : "Submitting…")
                : (poType === "normal" ? "Raise PO(s)" : "Submit for Approval")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
