"use client"

import { useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
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
import { PaginationBar } from "@/components/ui/pagination-bar"
import { CsvImportDialog } from "@/components/masters/CsvImportDialog"
import type { MfgLineOption, MiscCostLine, MiscCostType } from "@/types/masters"
import { wastageFraction } from "@/lib/costing/final-costing"
import { fmtDate, fmtMoney } from "../mfg-utils"
import MiscCostDialog from "./MiscCostDialog"
import { miscCostBulkCsvFields } from "./misc-cost-bulk-fields"
import { useEditGuard } from "@/components/AccessContext"

const TYPE_LABEL: Record<MiscCostType, string> = {
  jw: "Job Work",
  shrink: "Shrink Wrap",
  shipper: "Shipper",
  utility: "Utility",
  margin: "Margin",
  rm_loss: "RM Wastage",
  pm_loss: "PM Wastage",
}

const isPercentType = (t: MiscCostType) => t === "rm_loss" || t === "pm_loss"

/**
 * Active carries the live line AND the pending one: an in_review row is the
 * line being reviewed, not an archived one, and hiding it would make a cost
 * look missing while its edit is waiting. Everything else is the archive —
 * bom_misc keeps no history of its own, so a retired line IS the record that
 * a cost once applied.
 */
const LIVE_STATUSES = new Set(["active", "in_review"])

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
  const [view, setView] = useState<"active" | "archive">("active")
  // Page and size live in the URL because PaginationBar writes them there.
  const sp = useSearchParams()
  const pageSize = Math.max(1, Number(sp.get("size")) || 20)
  const rawPage = Math.max(1, Number(sp.get("page")) || 1)

  const activeCount = useMemo(() => rows.filter((r) => LIVE_STATUSES.has(String(r.status))).length, [rows])
  const archiveCount = rows.length - activeCount

  const filteredRows = useMemo(() => {
    const inView = rows.filter((r) =>
      view === "active" ? LIVE_STATUSES.has(String(r.status)) : !LIVE_STATUSES.has(String(r.status)))
    const q = search.trim().toLowerCase()
    if (!q) return inView
    return inView.filter((r) =>
      (r.sku_code ?? "").toLowerCase().includes(q) ||
      (r.sku_name ?? "").toLowerCase().includes(q) ||
      (r.bom_code ?? "").toLowerCase().includes(q)
    )
  }, [rows, search, view])

  // Searching or switching view can leave the URL on a page past the end —
  // clamp rather than redirect, so the table never renders blank.
  const lastPage = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const page = Math.min(rawPage, lastPage)
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize)

  // The SKUs this manufacturer actually produces, so the upload preview can
  // refuse a row for one it does not — the check that used to fire inside
  // applyAndArchive, after an approver had already clicked approve.
  const bulkFields = useMemo(
    () => miscCostBulkCsvFields(options.map((o) => o.sku_code).filter(Boolean) as string[]),
    [options]
  )

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
            fields={bulkFields}
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
        <div className="inline-flex h-9 items-center rounded-lg border border-border p-0.5">
          {([["active", "Active", activeCount], ["archive", "Archive", archiveCount]] as const).map(
            ([key, label, count]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
                  view === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
                <span className={view === key ? "opacity-80" : "opacity-60"}>({count})</span>
              </button>
            )
          )}
        </div>
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
                {pageRows.length === 0 ? (
                  <TableEmpty
                    colSpan={9}
                    action={
                      search.trim() ? (
                        <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                          Clear search
                        </Button>
                      ) : view === "archive" ? (
                        <Button variant="outline" size="sm" onClick={() => setView("active")}>
                          Back to Active
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => { if (guard("add a misc cost")) setDialogTarget("new") }}>
                          <Plus /> Add Cost / Wastage %
                        </Button>
                      )
                    }
                  >
                    {search.trim()
                      ? "No cost lines match this search."
                      : view === "archive"
                      ? "Nothing archived — no cost line here has been rejected or retired."
                      : "No Job Work, Shrink Wrap, Shipper, Utility, Margin or Wastage % recorded yet."}
                  </TableEmpty>
                ) : (
                  pageRows.map((r) => (
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
            <PaginationBar total={filteredRows.length} page={page} pageSize={pageSize} />
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
