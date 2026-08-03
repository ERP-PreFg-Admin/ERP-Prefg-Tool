"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Pencil } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import type { MfgLineOption, MiscCostLine, MiscCostType } from "@/types/masters"
import { fmtDate, fmtMoney } from "../mfg-utils"
import MiscCostDialog from "./MiscCostDialog"
import { MISC_COST_BULK_CSV_FIELDS } from "./misc-cost-bulk-fields"

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
            endpoint={`/api/manufacturing/misc-costs?mfg_id=${mfgId}`}
            templateFilename="misc_cost_bulk_template.csv"
            fields={MISC_COST_BULK_CSV_FIELDS}
            onSuccess={() => router.refresh()}
          />
          <DownloadButton
            endpoint={`/api/manufacturing/${mfgId}/misc-costs/export`}
            label="Current Misc. Cost Rates"
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU, BOM…"
          className="flex h-9 w-full sm:max-w-xs rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={() => setDialogTarget("new")}
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
                  <TableHead>BOM Code</TableHead>
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
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                      No cost lines yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono">{r.sku_code ?? "—"}</TableCell>
                      <TableCell className="font-mono">{r.bom_code ?? "—"}</TableCell>
                      <TableCell className="max-w-40 truncate">{r.sku_name ?? "—"}</TableCell>
                      <TableCell>{TYPE_LABEL[r.type]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {isPercentType(r.type) ? `${Number(r.cost ?? 0).toFixed(2)}%` : fmtMoney(r.cost)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_till)}</TableCell>
                      <TableCell><Badge variant={r.status === "active" ? "success" : "secondary"} className="capitalize">{r.status}</Badge></TableCell>
                      <TableCell className="text-right">
                        <button
                          onClick={() => setDialogTarget(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent transition-colors"
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
