"use client"

import { useEffect, useMemo, useState } from "react"
import { X } from "lucide-react"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DatePicker } from "@/components/ui/date-picker"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { useToast } from "@/components/ui/toast"
import { RemarksField, PO_REASON_PRESETS } from "@/components/masters/RemarksField"
import type { RecipeChoice, MfgOption, MfgSkuOption, WarehouseOption } from "./po-types"
import { warehousesForEntity, warehouseLabel, warehouseKey } from "./po-utils"
import { useQuotedRate } from "./useQuotedRate"
import { todayIST } from "@/lib/date"

type PoType = "normal" | "impromptu"

type PoLineRowState = {
  sku_code: string
  sku_name: string
  /** The recipes this manufacturer produces the SKU under, active first. */
  boms: RecipeChoice[]
  /** Selected recipe, as a string because it comes back off a <Select>. */
  recipe_id: string
  qty: string
  expected_on: string
  destination: string
  /** Which legal entity sells this SKU — narrows this row's destination list. */
  entity_code: string | null
}

/**
 * The first mother warehouse this entity actually operates, else the first site
 * offered. Per row rather than per dialog: two SKUs in one batch can belong to
 * different entities, and the old dialog-wide default could preselect a site the
 * row's entity has no facility at.
 */
function defaultDestination(options: WarehouseOption[]): string {
  return (
    options.find((w) => w.name.toLowerCase().includes("mumbai"))?.name
    ?? options.find((w) => w.type === "MWH")?.name
    ?? ""
  )
}

/** A picked SKU as an empty order line. */
function makeRow(s: MfgSkuOption, warehouseOptions: WarehouseOption[]): PoLineRowState {
  return {
    sku_code: s.sku_code,
    sku_name: s.sku_name,
    boms: s.boms ?? [],
    // The API sorts active recipes first, so the default is the live one
    // whenever there is a choice to make.
    recipe_id: s.boms?.[0] ? String(s.boms[0].recipe_id) : "",
    qty: "",
    expected_on: "",
    entity_code: s.entity_code ?? null,
    // Defaulted from THIS row's entity's warehouses, so the preselected
    // destination is always one the row can actually be sent to.
    destination: defaultDestination(warehousesForEntity(warehouseOptions, s.entity_code)),
  }
}

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

  // Only this SKU's entity's facilities. A NULL entity_code means unattributed, so
  // nothing is narrowed — see warehousesForEntity.
  const destinations = useMemo(
    () => warehousesForEntity(warehouseOptions, row.entity_code),
    [warehouseOptions, row.entity_code]
  )

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-2 py-1.5 align-top">
        <div className="font-mono text-xs font-medium">{row.sku_code}</div>
        <div className="text-[11px] text-muted-foreground max-w-40 truncate">{row.sku_name}</div>
      </td>
      {/* Recipe — one recipe is the norm, so it reads as text; only a SKU this
          manufacturer builds two ways makes the user choose. */}
      <td className="px-2 py-1.5 align-top">
        {row.boms.length === 0 ? (
          <span className="text-[11px] text-destructive">No Recipe on this line</span>
        ) : row.boms.length === 1 ? (
          <span className="font-mono text-[11px] text-muted-foreground">{row.boms[0].bom_code}</span>
        ) : (
          <Select
            value={row.recipe_id}
            onChange={(e) => onChange("recipe_id", e.target.value)}
            className="h-8 w-40 text-xs"
          >
            {row.boms.map((b) => (
              <option key={b.recipe_id} value={String(b.recipe_id)}>
                {b.bom_code}{b.status !== "active" ? ` (${b.status})` : ""}
              </option>
            ))}
          </Select>
        )}
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
        <DatePicker
          min={today}
          value={row.expected_on}
          onChange={(v) => onChange("expected_on", v)}
          className="h-8 w-36 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 align-top">
        {/* w-56, not w-full: in an auto-layout table `w-full` resolves against a
            cell the browser has already squeezed to fit, so the closed select
            collapsed to "Mu…" and the selected destination became unreadable. An
            explicit width makes the column claim its space and the container
            scroll instead — same approach as the qty/date inputs beside it. */}
        <Select
          value={row.destination}
          onChange={(e) => onChange("destination", e.target.value)}
          className="w-56 text-xs"
        >
          <option value="">— Select —</option>
          {destinations.map((w) => (
            <option key={warehouseKey(w)} value={w.name}>
              {warehouseLabel(w)}
            </option>
          ))}
        </Select>
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
  // The manufacturer's catalog, and the lines actually being ordered. These used
  // to be the same thing: picking a manufacturer seeded a row per SKU, so
  // ordering two SKUs meant scrolling ~30 rows of empty inputs that submission
  // then filtered out again. The catalog is now search options; a row exists
  // because someone asked for it.
  const [skuOptions, setSkuOptions] = useState<MfgSkuOption[]>([])
  const [rows, setRows]             = useState<PoLineRowState[]>([])
  const [loadingSkus, setLoadingSkus] = useState(false)
  const [skusError, setSkusError]   = useState("")
  const [reason, setReason]         = useState("")
  const [rowErrors, setRowErrors]   = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError]     = useState("")
  const { toast } = useToast()

  const today = todayIST()

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets form state each time the dialog is opened
      setPoType("normal")
      setMfgId("")
      setSkuOptions([])
      setRows([])
      setReason("")
      setRowErrors({})
      setApiError("")
      setSkusError("")
    }
  }, [open])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears rows when the dialog closes or the manufacturer selection is cleared
    if (!open || !mfgId) { setSkuOptions([]); setRows([]); return }
    setLoadingSkus(true)
    setSkusError("")
    setRowErrors({})
    // Changing manufacturer drops the lines: a SKU's recipe, rate and entity are
    // all per-manufacturer, so a row carried across would price against the
    // wrong one.
    setRows([])
    fetch(`/api/v1/purchase-orders/mfg-skus?mfg_id=${mfgId}`)
      .then((r) => r.json())
      .then((data: { skus?: MfgSkuOption[] }) => setSkuOptions(data.skus ?? []))
      .catch(() => setSkusError("Failed to load SKUs for this manufacturer."))
      .finally(() => setLoadingSkus(false))
  }, [open, mfgId])

  // Already-ordered SKUs leave the picker — rows are keyed by sku_code, so the
  // same SKU twice would edit one row from two places.
  const unpicked = useMemo(
    () => skuOptions.filter((s) => !rows.some((r) => r.sku_code === s.sku_code)),
    [skuOptions, rows]
  )

  function addSku(skuCode: string) {
    const sku = skuOptions.find((s) => s.sku_code === skuCode)
    if (!sku) return
    setRows((prev) => [...prev, makeRow(sku, warehouseOptions)])
    setApiError("")
  }

  function setRowField(sku_code: string, field: keyof PoLineRowState, value: string) {
    setRows((prev) => prev.map((r) => (r.sku_code === sku_code ? { ...r, [field]: value } : r)))
    setRowErrors((e) => ({ ...e, [sku_code]: "" }))
    setApiError("")
  }

  async function handleSubmit() {
    setApiError("")
    if (!mfgId) { setApiError("Select a manufacturer."); return }

    if (rows.length === 0) { setApiError("Add at least one SKU."); return }

    if (poType === "impromptu" && !reason.trim()) {
      setApiError("Remarks are required for Impromptu POs.")
      return
    }

    // Every row is now here because someone searched for it, so a missing
    // quantity is a mistake to report — not a row to quietly skip, which is what
    // the old pre-seeded-every-SKU list needed.
    const errs: Record<string, string> = {}
    for (const r of rows) {
      if (!(Number(r.qty) > 0)) errs[r.sku_code] = "Enter a quantity, or remove this SKU."
      else if (!r.recipe_id) errs[r.sku_code] = "No Recipe on this manufacturer's line for this SKU — it can't be ordered."
      else if (!r.expected_on) errs[r.sku_code] = "Expected dispatch date is required."
      else if (r.expected_on < today) errs[r.sku_code] = "Backdating is not allowed."
    }
    if (Object.keys(errs).length > 0) { setRowErrors(errs); return }

    setSubmitting(true)
    const outcomes: { sku_code: string; ok: boolean; message: string }[] = []

    for (const r of rows) {
      try {
        const rateRes = await fetch(
          `/api/v1/purchase-orders/quote-rate?sku_code=${encodeURIComponent(r.sku_code)}&mfg_id=${mfgId}`
        )
        const rateData = await rateRes.json()
        if (!rateRes.ok || rateData.rate == null) {
          outcomes.push({ sku_code: r.sku_code, ok: false, message: rateData.error ?? "Rate unavailable." })
          continue
        }
        const unitPrice = rateData.rate as number
        const totalAmt  = unitPrice * Number(r.qty)

        const res = await fetch("/api/v1/purchase-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            po_type:      poType,
            mfg_id:       Number(mfgId),
            sku_code:     r.sku_code,
            recipe_id:       Number(r.recipe_id),
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

    // Partial failure — DROP the rows that succeeded and keep the dialog open
    // with per-row errors on the rest, so a retry resubmits only what failed.
    //
    // Dropped, not blanked: their POs exist now, and a blanked row would fail
    // the "enter a quantity" check above and block the retry it is meant to
    // allow.
    setRows((prev) => prev.filter((r) => !outcomes.some((o) => o.ok && o.sku_code === r.sku_code)))
    const errMap: Record<string, string> = {}
    for (const f of failed) errMap[f.sku_code] = f.message
    setRowErrors(errMap)
    const summary = succeeded.length > 0
      ? `${succeeded.length} PO${succeeded.length !== 1 ? "s" : ""} created, ${failed.length} failed — see errors below.`
      : `All ${failed.length} PO${failed.length !== 1 ? "s" : ""} failed — see errors below.`
    setApiError(summary)
    toast({ title: succeeded.length > 0 ? "Some POs failed" : "Couldn't create POs", description: summary, variant: "error" })
    if (succeeded.length > 0) onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      {/* max-w-5xl: eight columns, and the destination now carries a facility code.
          At 3xl the table overflowed and the remove button sat off-screen behind a
          scrollbar. */}
      <DialogContent className="max-w-5xl">
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
            <Select
              id="apo-mfg" value={mfgId}
              onChange={(e) => setMfgId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— Select MFG —</option>
              {mfgOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.code} — {m.name}</option>
              ))}
            </Select>
          </div>

          {/* Search to add a SKU, then one line per added SKU: qty, rate,
              dispatch, destination. */}
          {mfgId && !loadingSkus && !skusError && skuOptions.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="apo-sku">
                Add SKU
                {rows.length > 0 && (
                  <span className="ml-1 font-normal text-muted-foreground">({rows.length} added)</span>
                )}
              </Label>
              {/* value="" always: this is a search box, not a display of the
                  current pick — the picks are the rows below. */}
              <FuzzySelect
                options={unpicked}
                value=""
                onChange={(v) => v && addSku(v)}
                getValue={(s) => s.sku_code}
                getLabel={(s) => `${s.sku_code} — ${s.sku_name}`}
                searchKeys={["sku_code", "sku_name"]}
                placeholder="Search SKU code or name…"
              />
            </div>
          )}

          {!mfgId ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Select a manufacturer to order its SKUs.
            </p>
          ) : loadingSkus ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Loading SKUs…</p>
          ) : skusError ? (
            <p className="text-xs text-destructive py-4 text-center">{skusError}</p>
          ) : skuOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              This manufacturer has no active SKUs to order.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Search a SKU above to add it to this PO.
            </p>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">SKU</th>
                    <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Recipe</th>
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
            <RemarksField
              id="apo-reason"
              label="Reason / Notes"
              required={poType === "impromptu"}
              helperText={poType === "impromptu" ? "Required for Impromptu POs — briefly explain why these are being raised." : ""}
              placeholder="Why are these POs being raised? Any special instructions…"
              value={reason}
              onChange={setReason}
              presets={PO_REASON_PRESETS}
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
