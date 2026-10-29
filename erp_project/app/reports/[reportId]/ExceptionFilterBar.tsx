"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { FuzzySelect } from "@/components/ui/FuzzySelect"
import { DatePicker } from "@/components/ui/date-picker"
import { MasterToolbar } from "@/components/masters/MasterToolbar"
import { FilterField, FilterPanel, FilterToggleButton, useFilterPanel } from "@/components/masters/FilterPanel"
import { useUrlFilters } from "@/lib/useUrlFilters"

const KEYS = ["mfg", "q", "age", "min", "from", "to"] as const

// Exception inbox filters: manufacturer, search, minimum age, minimum ₹ at stake (all in the URL).
export default function ExceptionFilterBar({ values, mfgs }: { values: Record<string, string>; mfgs: { code: string; name: string }[] }) {
  const { navigate } = useUrlFilters()
  const panel = useFilterPanel()
  const [draft, setDraft] = useState<Record<string, string>>(Object.fromEntries(KEYS.map((k) => [k, values[k] ?? ""])))
  const set = (k: string) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))
  const cleared = Object.fromEntries(KEYS.map((k) => [k, ""]))

  return (
    <>
      <MasterToolbar>
        <FilterToggleButton open={panel.open} onToggle={panel.toggle} activeCount={KEYS.filter((k) => values[k]).length} />
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
        <FilterField label="Search (record, SKU, batch, detail)">
          <Input value={draft.q} onChange={(e) => set("q")(e.target.value)} placeholder="e.g. invoice no. or SKU" />
        </FilterField>
        <FilterField label="Problem started from">
          <DatePicker value={draft.from} onChange={set("from")} max={draft.to || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label="Problem started to">
          <DatePicker value={draft.to} onChange={set("to")} min={draft.from || undefined} placeholder="Any date" />
        </FilterField>
        <FilterField label="At least this many days old">
          <Input type="number" min={0} value={draft.age} onChange={(e) => set("age")(e.target.value)} placeholder="Any age" />
        </FilterField>
        <FilterField label="At least ₹ at stake (₹ items only)">
          <Input type="number" min={0} value={draft.min} onChange={(e) => set("min")(e.target.value)} placeholder="Any value" />
        </FilterField>
      </FilterPanel>
    </>
  )
}
