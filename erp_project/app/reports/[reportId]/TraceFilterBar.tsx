"use client"

import { useState } from "react"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DatePicker } from "@/components/ui/date-picker"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import { FilterField, FilterPanel, FilterToggleButton, useFilterPanel } from "@/components/masters/FilterPanel"
import { useUrlFilters } from "@/lib/useUrlFilters"
import type { TraceTab } from "@/lib/reports/trace/contracts"

const STATUS_LABEL: Record<string, string> = {
  matched: "Matched", short_received: "Short received", over_received: "Over received",
  billed_not_received: "Billed, not received", received_not_billed: "Received, not billed", grn_not_synced: "GRN not synced",
}

// Dataset tabs + the filters every dataset shares (all in the URL), plus T2's status and T6's month toggle.
const PROVENANCE_LABEL: Record<string, string> = {
  all_invoiced: "All received via invoices", partly_without_invoice: "Partly without invoice", no_invoice: "Received, no invoice",
  opening_balance: "Opening balance (no history)", nothing_received: "Nothing received", data_error: "Data error (invoiced > received)",
}
const SOURCE_LABEL: Record<string, string> = {
  invoice: "Invoice", invoice_revert: "Invoice revert", backfill: "Sept backfill", hand_fix: "Hand fix", manual: "Manual receipt", unknown: "Unknown",
}

export default function TraceFilterBar({ tab, tabs, values, mfgs, destinations, groups }: {
  tab: TraceTab
  tabs: { key: TraceTab; label: string }[]
  values: Record<string, string>
  mfgs: { code: string; name: string }[]
  destinations: string[]
  /** This dataset's group-by choices (TRACE_GROUPS). */
  groups: { id: string; label: string }[]
}) {
  const { navigate, pathname, searchParams } = useUrlFilters()
  const panel = useFilterPanel()
  const keys = ["mfg", "dest", "sku", "po", "inv", "batch", "from", "to", "status", "month", "prov", "source"]
  const [draft, setDraft] = useState<Record<string, string>>(Object.fromEntries(keys.map((k) => [k, values[k] ?? ""])))
  const set = (k: string) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))
  const cleared = Object.fromEntries(keys.map((k) => [k, ""]))
  const activeCount = keys.filter((k) => values[k]).length

  const tabHref = (k: TraceTab) => {
    const p = new URLSearchParams(searchParams.toString())
    p.set("tab", k)
    p.delete("page")
    p.delete("group") // group choices differ per dataset
    return `${pathname}?${p.toString()}`
  }

  return (
    <>
      <MasterToolbar>
        <SegmentedToggle options={tabs} active={tab} getHref={tabHref} />
        <FilterToggleButton open={panel.open} onToggle={panel.toggle} activeCount={activeCount} />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Group by
          <Select value={values.group ?? ""} onChange={(e) => navigate({ group: e.target.value })} className="h-8 w-40 text-xs">
            <option value="">No grouping (rows)</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </Select>
        </label>
      </MasterToolbar>

      <FilterPanel
        open={panel.open}
        onClose={panel.close}
        onApply={() => { navigate(draft); panel.close() }}
        onClear={() => { setDraft(cleared); navigate(cleared); panel.close() }}
      >
        <FilterField label="Manufacturer">
          <FuzzySelect
            options={[{ code: "", name: "All manufacturers" }, ...mfgs]}
            value={draft.mfg}
            onChange={set("mfg")}
            getLabel={(o) => (o.code ? `${o.code} — ${o.name}` : o.name)}
            getValue={(o) => o.code}
            searchKeys={["code", "name"]}
            placeholder="All manufacturers"
          />
        </FilterField>
        <FilterField label={tab === "t3" || tab === "t4" || tab === "t6" ? "Destination (PO)" : "Destination (invoice)"}>
          <FuzzySelect options={["", ...destinations]} value={draft.dest} onChange={set("dest")}
            getLabel={(d) => d || "All destinations"} placeholder="All destinations" />
        </FilterField>
        <FilterField label="SKU code (exact)">
          <Input value={draft.sku} onChange={(e) => set("sku")(e.target.value)} placeholder="e.g. MCaf199_WB" />
        </FilterField>
        <FilterField label="PO no. (procurement, split or inward)">
          <Input value={draft.po} onChange={(e) => set("po")(e.target.value)} placeholder="Exact PO number" />
        </FilterField>
        <FilterField label="Invoice no. (contains)">
          <Input value={draft.inv} onChange={(e) => set("inv")(e.target.value)} />
        </FilterField>
        <FilterField label="Batch (case, spaces, - / . _ ignored)">
          <Input value={draft.batch} onChange={(e) => set("batch")(e.target.value)} />
        </FilterField>
        <FilterField label={tab === "t3" || tab === "t4" || tab === "t6" ? "PO date from" : "Inwarded from"}>
          <DatePicker value={draft.from} onChange={set("from")} max={draft.to || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label={tab === "t3" || tab === "t4" || tab === "t6" ? "PO date to" : "Inwarded to"}>
          <DatePicker value={draft.to} onChange={set("to")} min={draft.from || undefined} placeholder="Any date" />
        </FilterField>
        {tab === "t2" && (
          <FilterField label="Batch status">
            <Select value={draft.status} onChange={(e) => set("status")(e.target.value)} className="w-full">
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </FilterField>
        )}
        {tab === "t3" && (
          <FilterField label="Provenance">
            <Select value={draft.prov} onChange={(e) => set("prov")(e.target.value)} className="w-full">
              <option value="">All</option>
              {Object.entries(PROVENANCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </FilterField>
        )}
        {tab === "t4" && (
          <FilterField label="Receipt source">
            <Select value={draft.source} onChange={(e) => set("source")(e.target.value)} className="w-full">
              <option value="">All</option>
              {Object.entries(SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </FilterField>
        )}
        {tab === "t6" && (
          <FilterField label="Group">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.month === "1"} onChange={(e) => set("month")(e.target.checked ? "1" : "")} />
              Split by PO month
            </label>
          </FilterField>
        )}
      </FilterPanel>
    </>
  )
}
