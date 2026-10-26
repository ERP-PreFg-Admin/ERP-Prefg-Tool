"use client"

import { useState } from "react"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DatePicker } from "@/components/ui/date-picker"
import { SegmentedToggle } from "@/components/ui/segmented-toggle"
import { UrlSearchInput } from "@/components/masters/UrlSearchInput"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import { FilterField, FilterPanel, FilterToggleButton, useFilterPanel } from "@/components/masters/FilterPanel"
import { useUrlFilters } from "@/lib/useUrlFilters"

export type InvoiceFilterValues = {
  search: string | null
  mfgCode: string | null
  destination: string | null
  dateFrom: string | null
  dateTo: string | null
}

// Tabs + the filters INV-01 and INV-02 share; `extra` is the one field each tab adds.
export default function InvoiceFilterBar({ tab, filters, mfgs, destinations, extra }: {
  tab: "exceptions" | "rates"
  filters: InvoiceFilterValues
  mfgs: { code: string; name: string }[]
  destinations: string[]
  extra: { key: string; label: string; value: string; render: (value: string, set: (v: string) => void) => React.ReactNode }
}) {
  const { navigate, pathname } = useUrlFilters()
  const panel = useFilterPanel()
  const initial = { mfg: filters.mfgCode ?? "", dest: filters.destination ?? "", from: filters.dateFrom ?? "", to: filters.dateTo ?? "" }
  const [draft, setDraft] = useState<Record<string, string>>({ ...initial, [extra.key]: extra.value })
  const set = (k: string) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))
  const cleared = { mfg: "", dest: "", from: "", to: "", [extra.key]: "" }
  const activeCount = [filters.mfgCode, filters.destination, filters.dateFrom, filters.dateTo].filter(Boolean).length

  return (
    <>
      <MasterToolbar>
        <SegmentedToggle
          options={[{ key: "exceptions", label: "Match exceptions" }, { key: "rates", label: "Rate vs PO" }] as const}
          active={tab}
          getHref={(k) => `${pathname}?tab=${k}`}
        />
        <UrlSearchInput initialValue={filters.search ?? ""} placeholder="Search invoice no or manufacturer…" />
        <FilterToggleButton open={panel.open} onToggle={panel.toggle} activeCount={activeCount} />
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
        <FilterField label="Destination">
          <FuzzySelect options={["", ...destinations]} value={draft.dest} onChange={set("dest")}
            getLabel={(d) => d || "All destinations"} placeholder="All destinations" />
        </FilterField>
        <FilterField label={extra.label}>{extra.render(draft[extra.key] ?? "", set(extra.key))}</FilterField>
        <FilterField label="Inwarded from">
          <DatePicker value={draft.from} onChange={set("from")} max={draft.to || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label="Inwarded to">
          <DatePicker value={draft.to} onChange={set("to")} min={draft.from || undefined} placeholder="Any date" />
        </FilterField>
      </FilterPanel>
    </>
  )
}
