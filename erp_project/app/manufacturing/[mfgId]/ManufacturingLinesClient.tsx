"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Pencil, AlertTriangle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { DownloadButton } from "@/components/masters/DownloadButton"
import { useToast } from "@/components/ui/toast"
import type { MfgLine, MfgLineStatus } from "@/types/masters"
import { fmtDate } from "../mfg-utils"
import LineDialog, { type RecipeOption } from "./LineDialog"
import { useEditGuard } from "@/components/AccessContext"

type LiveBomInfo = { bomCodes: string; bomIds: number[] }

function fmtFilling(filling: number | null, uom: string | null) {
  if (filling == null) return "—"
  return uom ? `${filling} ${uom}` : String(filling)
}

const STATUS_LABEL: Record<MfgLineStatus, string> = {
  active: "Active",
  discontinued: "Discontinued",
  inactive: "Inactive",
}

const STATUS_BADGE_VARIANT: Record<MfgLineStatus, "success" | "warning" | "secondary"> = {
  active: "success",
  discontinued: "warning",
  inactive: "secondary",
}

type StatusFilter = "all" | MfgLineStatus

export default function ManufacturingLinesClient({
  mfgId,
  rows,
  bomOptions,
  liveBomsBySkuCode,
  costingWarnings,
}: {
  mfgId: number
  rows: MfgLine[]
  bomOptions: RecipeOption[]
  liveBomsBySkuCode?: Map<string, LiveBomInfo>
  /** recipe_id → why Agreed Final Costing can't price this line, from costing-gaps.ts. */
  costingWarnings?: Map<number, string[]>
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [search, setSearch] = useState("")
  const guard = useEditGuard()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [dialogTarget, setDialogTarget] = useState<MfgLine | null | "new">(null)
  const [pausingBomId, setPausingBomId] = useState<number | null>(null)

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false
      if (!q) return true
      return (
        (r.sku_code ?? "").toLowerCase().includes(q) ||
        (r.sku_name ?? "").toLowerCase().includes(q) ||
        (r.bom_code ?? "").toLowerCase().includes(q)
      )
    })
  }, [rows, search, statusFilter])

  const afterAction = () => { setDialogTarget(null); router.refresh() }

  async function handlePauseBom(bomId: number) {
    setPausingBomId(bomId)
    try {
      const res = await fetch("/api/v1/masters/recipe-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-status", recipe_id: bomId, status: "inactive" }),
      })
      if (res.ok) {
        toast({ title: "Line paused", variant: "success" })
        router.refresh()
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: "Couldn't pause line", description: data.error, variant: "error" })
      }
    } catch {
      toast({ title: "Couldn't pause line", description: "Network error. Please try again.", variant: "error" })
    } finally {
      setPausingBomId(null)
    }
  }

  return (
    <div className="space-y-4 text-xs">
      {/* ── Toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU, Recipe…"
          className="flex h-9 w-full sm:max-w-xs rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex items-center gap-1.5">
          {(["all", "active", "discontinued", "inactive"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap " +
                (statusFilter === f
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground border border-input")
              }
            >
              {f === "all" ? "All" : STATUS_LABEL[f]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <DownloadButton
            endpoint={`/api/v1/manufacturing/${mfgId}/lines/export`}
            label="Manufacturing Lines"
          />
          <button
            onClick={() => { if (guard("add a line")) setDialogTarget("new") }}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add SKUs
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      <Card>
        <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Recipe Code</TableHead>
                  <TableHead>SKU Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Effective From</TableHead>
                  <TableHead>Effective To</TableHead>
                  <TableHead>Filling</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                      No manufacturing lines match this view.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRows.map((r) => {
                    const liveBoms = r.sku_code ? liveBomsBySkuCode?.get(r.sku_code) : undefined
                    const isOlderLiveBom =
                      !!liveBoms && liveBoms.bomIds.length > 1 && r.recipe_id !== liveBoms.bomIds[liveBoms.bomIds.length - 1]
                    // One icon carries both kinds of problem — two amber badges
                    // on the same cell read as two severities when they aren't.
                    const warnings = [
                      ...(liveBoms
                        ? [`Multiple Recipes are currently live for this SKU (${liveBoms.bomCodes}) — production can happen on any of them until the older one is paused.`]
                        : []),
                      ...(costingWarnings?.get(r.recipe_id) ?? []),
                    ]
                    return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono">
                        <div className="flex items-center gap-1.5">
                          {warnings.length > 0 && (
                            <span
                              title={warnings.join("\n")}
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 cursor-help"
                            >
                              <AlertTriangle className="h-2.5 w-2.5" />
                            </span>
                          )}
                          {r.sku_code ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">
                        <div className="flex items-center gap-1.5">
                          {r.bom_code ?? "—"}
                          {isOlderLiveBom && (
                            <button
                              onClick={() => handlePauseBom(r.recipe_id)}
                              disabled={pausingBomId === r.recipe_id}
                              title="Set this older Recipe to Inactive so production stops on it"
                              className="rounded border border-amber-300 px-1 py-0.5 text-[10px] text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/20"
                            >
                              {pausingBomId === r.recipe_id ? "Pausing…" : "Pause"}
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-40 truncate">{r.sku_name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[r.status]}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_from)}</TableCell>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.effective_to)}</TableCell>
                      <TableCell className="whitespace-nowrap">{fmtFilling(r.filling, r.filling_uom)}</TableCell>
                      <TableCell className="text-right">
                        <button
                          onClick={() => { if (guard("edit a line")) setDialogTarget(r) }}
                          className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent transition-colors"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </TableCell>
                    </TableRow>
                  )})
                )}
              </TableBody>
            </Table>
        </CardContent>
      </Card>

      <LineDialog
        open={dialogTarget !== null}
        onClose={() => setDialogTarget(null)}
        onSaved={afterAction}
        mfgId={mfgId}
        bomOptions={bomOptions}
        editData={dialogTarget && dialogTarget !== "new" ? dialogTarget : null}
      />
    </div>
  )
}
