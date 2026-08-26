"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Pencil } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/ui/empty-state"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { SearchInput } from "@/components/masters/SearchInput"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import type { MfgLineOption, MiscCostLine, MiscCostType } from "@/types/masters"
import { wastageFraction } from "@/lib/costing/final-costing"
import { fmtDate, fmtMoney } from "../mfg-utils"
import MiscCostDialog from "./MiscCostDialog"
import { MISC_COST_BULK_CSV_FIELDS } from "./misc-cost-bulk-fields"
import { useEditGuard } from "@/components/AccessContext"

const TYPE_LABEL: Record<MiscCostType, string> = {
  jw: "Job Work",
  shrink: "Shrink Wrap",
  shipper: "Shipper",
  rm_loss: "RM Wastage",
  pm_loss: "PM Wastage",
}

const isPercentType = (t: MiscCostType) => t === "rm_loss" || t === "pm_loss"

export default function MiscCostClient({
  mfgId,
  rows,
  options,
}: {
  mfgId: number
  rows: MiscCostLine[]
  options: MfgLineOption[]
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const guard = useEditGuard()
  const [dialogTarget, setDialogTarget] = useState<MiscCostLine | null | "new">(null)

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      (r.sku_code ?? "").toLowerCase().includes(q) ||
      (r.sku_name ?? "").toLowerCase().includes(q) ||
      (r.bom_code ?? "").toLowerCase().includes(q)
    )
  }, [rows, search])

  const afterAction = () => { setDialogTarget(null); router.refresh() }

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Job Work, Shrink Wrap, Shipper, and RM/PM Wastage % — all in one table, distinguished by Type.
        </p>
        <div className="flex items-center gap-2">
          <CsvImportDialog
            entityLabel="Cost Line"
            title="Bulk Upload Job Work / Shrink Wrap / Shipper / Wastage"
            endpoint={`/api/v1/manufacturing/misc-costs?mfg_id=${mfgId}`}
            templateFilename="misc_cost_bulk_template.csv"
            fields={MISC_COST_BULK_CSV_FIELDS}
            onSuccess={() => router.refresh()}
          />
          <DownloadButton
            endpoint={`/api/v1/manufacturing/${mfgId}/misc-costs/export`}
            label="Current Misc. Cost Rates"
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search SKU, Recipe…"
          className="sm:max-w-xs"
        />
        <button
          onClick={() => { if (guard("add a misc cost")) setDialogTarget("new") }}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors sm:ml-auto"
        >
          <Plus className="h-3.5 w-3.5" /> Add Cost / Wastage %
        </button>
      </div>

      <Card>
        <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Recipe Code</TableHead>
                  <TableHead>SKU Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Cost / %</TableHead>
                  <TableHead>Effective From</TableHead>
                  <TableHead>Effective Till</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 ? (
                  <TableEmpty
                    colSpan={9}
                    action={
                      rows.length === 0 ? (
                        <Button variant="outline" size="sm" onClick={() => { if (guard("add a misc cost")) setDialogTarget("new") }}>
                          <Plus /> Add Cost / Wastage %
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                          Clear search
                        </Button>
                      )
                    }
                  >
                    {rows.length === 0
                      ? "No Job Work, Shrink Wrap, Shipper or Wastage % recorded yet."
                      : "No cost lines match this search."}
                  </TableEmpty>
                ) : (
                  filteredRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono">{r.sku_code ?? "—"}</TableCell>
                      <TableCell className="font-mono">{r.bom_code ?? "—"}</TableCell>
                      <TableCell className="max-w-40 truncate">{r.sku_name ?? "—"}</TableCell>
                      <TableCell>{TYPE_LABEL[r.type]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* wastageFraction, not the raw value: the stored number
                            is in one of two units, so printing it raw showed
                            "0.02%" for a row the costing charges 2% on. */}
                        {isPercentType(r.type)
                          ? `${(wastageFraction(Number(r.cost ?? 0)) * 100).toFixed(2)}%`
                          : fmtMoney(r.cost)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_till)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === "active" ? "success" : r.status === "in_review" ? "warning" : "secondary"}
                          className="capitalize"
                        >
                          {r.status === "in_review" ? "In Review" : r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {/* A line awaiting approval can't be edited — the route
                            would 409 on the pending approval anyway, so say so
                            here instead of letting someone fill in the dialog
                            first. */}
                        <button
                          onClick={() => { if (guard("edit a misc cost")) setDialogTarget(r) }}
                          disabled={r.status === "in_review"}
                          title={r.status === "in_review" ? "Awaiting approval — cannot be edited until approved or rejected" : undefined}
                          className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>

      <MiscCostDialog
        open={dialogTarget !== null}
        onClose={() => setDialogTarget(null)}
        onSaved={afterAction}
        mfgId={mfgId}
        options={options}
        editData={dialogTarget && dialogTarget !== "new" ? dialogTarget : null}
      />
    </div>
  )
}
