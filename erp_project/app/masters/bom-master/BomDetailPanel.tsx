"use client"

/**
 * Slide-in read-only detail panel for a selected BOM row. Editing happens in
 * a separate dialog (BomEditDialog.tsx) opened via the "Edit BOM" button
 * here — kept apart from this panel so the two don't compete for space and
 * the panel doesn't have to switch between read/edit layouts.
 */

import { X, Pencil, ExternalLink, Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatDate, LOCKED_STATUSES } from "./bom-format"
import { BomStatusBadge } from "./BomStatusBadge"
import type { BomDetailResponse } from "@/types/masters"

async function viewArtifact(s3Key: string) {
  try {
    const res = await fetch(`/api/files/presign?key=${encodeURIComponent(s3Key)}&view=1`)
    const data = await res.json()
    if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
  } catch {
    window.alert("Could not open file")
  }
}

export function BomDetailPanel({
  detail,
  detailLoading,
  detailError,
  activeMtrlType,
  onChangeMtrlType,
  rmLines,
  pmLines,
  rmDetailTotal,
  rmIsBalanced,
  visibleLines,
  canEdit,
  onClose,
  onEdit,
}: {
  detail: BomDetailResponse | null
  detailLoading: boolean
  detailError: string | null
  activeMtrlType: "rm" | "pm"
  onChangeMtrlType: (t: "rm" | "pm") => void
  rmLines: BomDetailResponse["lines"]
  pmLines: BomDetailResponse["lines"]
  rmDetailTotal: number
  rmIsBalanced: boolean
  visibleLines: BomDetailResponse["lines"]
  canEdit: boolean
  onClose: () => void
  onEdit: (bomId: number) => void
}) {
  return (
    <Card className="max-h-[calc(100vh-3rem)] flex flex-col">
      <CardHeader className="pb-3 shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold font-mono">
              {detail?.bom_code ?? "—"}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">BOM Detail</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 -mt-1 -mr-1"
            onClick={onClose}
            title="Close detail panel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 overflow-y-auto">
        {detailLoading && (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        )}

        {detailError && !detailLoading && (
          <p className="text-sm text-destructive py-6 text-center">{detailError}</p>
        )}

        {detail && !detailLoading && !detailError && (
          <>
            {/* ── Key fields summary ── */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">SKU Code</p>
                <p className="font-mono font-medium mt-0.5">{detail.sku_code ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <div className="mt-1">
                  <BomStatusBadge status={detail.status} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Effective From</p>
                <p className="font-medium mt-0.5">{formatDate(detail.effective_from)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Effective Till</p>
                <p className="font-medium mt-0.5">{formatDate(detail.effective_till)}</p>
              </div>
            </div>

            {/* ── Artifacts — read-only here; add/remove happens in the Edit
                   BOM dialog below, since attaching a file is bundled into
                   the same approval as the line edits. ── */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Artifacts ({detail.artifacts.length})
              </p>
              {detail.artifacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No artifacts attached.</p>
              ) : (
                <div className="space-y-1.5">
                  {detail.artifacts.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{a.file_name}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        title="View file"
                        onClick={() => viewArtifact(a.s3_key)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Material lines ── */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground">Material Lines</p>
                <div className="inline-flex rounded-lg border border-input p-0.5">
                  <button
                    type="button"
                    onClick={() => onChangeMtrlType("rm")}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      activeMtrlType === "rm"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    RM ({rmLines.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeMtrlType("pm")}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      activeMtrlType === "pm"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    PM ({pmLines.length})
                  </button>
                </div>
              </div>

              {activeMtrlType === "rm" && rmLines.length > 0 && (
                <div
                  className={cn(
                    "flex items-center justify-between rounded-lg px-3 py-2 mb-2 text-xs font-medium",
                    rmIsBalanced
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                  )}
                >
                  <span>{rmIsBalanced ? "RM formulation adds up to 100%" : "RM formulation does not total 100%"}</span>
                  <span className="font-mono">{rmDetailTotal.toFixed(2)}%</span>
                </div>
              )}

              {visibleLines.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No {activeMtrlType.toUpperCase()} lines found.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {visibleLines.map((line, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium truncate">
                            {line.mtrl_name ?? `ID ${line.mtrl_id ?? "—"}`}
                          </p>
                          {line.mtrl_master_status && line.mtrl_master_status !== "active" && (
                            <Badge variant="warning" className="shrink-0 text-[10px] px-1.5 py-0">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">
                          {line.mtrl_code ?? `#${line.mtrl_id ?? "—"}`}
                        </p>
                      </div>
                      <p className="text-sm font-semibold shrink-0 tabular-nums">
                        {line.amount ?? "—"}
                        {line.uom ? <span className="text-muted-foreground font-normal ml-1 text-xs uppercase">{line.uom}</span> : null}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {canEdit && detail.bom_id != null && !LOCKED_STATUSES.has(detail.status ?? "") && (
              <Button size="sm" variant="outline" onClick={() => onEdit(detail.bom_id!)}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit BOM
              </Button>
            )}
            {LOCKED_STATUSES.has(detail.status ?? "") && (
              <p className="text-xs text-muted-foreground">
                This BOM has a pending approval and can't be edited until it's resolved.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
