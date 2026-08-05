"use client"

import { ChevronDown, ChevronRight, Clock, FileText } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Approval } from "../approvals-types"
import { MODULE_LABEL, MODULE_COLOR, BULK_MODULES, HISTORY_STATUS_COLOR, getInitials, fmtDate } from "../approvals-types"
import { EntityInfo } from "./EntityInfo"
import { CsvFileCard } from "./CsvDiff"
import { BomLineDiffTable } from "./BomLineDiffTable"
import { FieldDiffTable } from "./FieldDiffTable"
import { ApprovalActions } from "./ApprovalActions"
import type { MaterialMap } from "./types"

export default function ApprovalCard({
  approval, isExpanded, isApprover, loading, error,
  onToggle, onApprove, onReject, onOpenCsvFile, materialMap, alwaysExpanded,
}: {
  approval:      Approval
  isExpanded:    boolean
  isApprover:    boolean
  loading:       boolean
  error?:        string
  onToggle:      () => void
  onApprove:     () => void
  onReject:      () => void
  onOpenCsvFile: (approvalId: number, s3Key: string, filename: string) => void
  /** RM/PM id → { code, name }, used to resolve BOM line materials by id. */
  materialMap?:  MaterialMap
  /** Skips the click-to-reveal-diff step: the field changes render inline
   *  right away since there's already a click needed to open the module
   *  group, and requiring a second click per item just to see what changed
   *  slows down approvals. Used on /approvals; history keeps the toggle
   *  since its list can be much longer. */
  alwaysExpanded?: boolean
}) {
  const moduleColor = MODULE_COLOR[approval.module] ?? "bg-slate-50 text-slate-700 border-slate-200"
  const isBulk      = BULK_MODULES.has(approval.module)
  const isBom       = approval.module === "BOM"
  const rowCount    = approval.items.find(i => i.field_name === "row_count")?.new_value
  const showDiff    = isExpanded || alwaysExpanded

  return (
    <div className={`rounded-xl border border-border bg-card overflow-hidden transition-all ${isExpanded ? "ring-1 ring-primary/20 shadow-sm" : ""}`}>

      {/* Header — clickable to reveal the diff, unless alwaysExpanded already shows it */}
      <div
        className={`w-full text-left px-4 py-2.5 transition-colors ${alwaysExpanded ? "" : "hover:bg-muted/30 cursor-pointer"}`}
        onClick={alwaysExpanded ? undefined : onToggle}
        role={alwaysExpanded ? undefined : "button"}
        tabIndex={alwaysExpanded ? undefined : 0}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${moduleColor}`}>
                {MODULE_LABEL[approval.module] ?? approval.module}
              </span>
              {approval.status && (
                <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold capitalize tracking-wide ${HISTORY_STATUS_COLOR[approval.status] ?? "bg-slate-50 text-slate-700 border-slate-200"}`}>
                  {approval.status}
                </span>
              )}
              {isBulk ? (
                <Badge variant="secondary" className="gap-1 text-[10px] h-4">
                  <FileText className="h-2.5 w-2.5" /> {rowCount ? `${rowCount} rows` : "1 CSV file"}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] h-4">
                  {approval.items.length} field{approval.items.length !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <EntityInfo approval={approval} />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right hidden sm:block">
              <div className="flex items-center justify-end gap-1.5">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground select-none">
                  {getInitials(approval.raised_by_name)}
                </div>
                <span className="text-xs font-medium">{approval.raised_by_name}</span>
              </div>
              <div className="flex items-center justify-end gap-1 mt-0.5 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" />
                {fmtDate(approval.raised_on)}
              </div>
            </div>
            {!alwaysExpanded && (
              isExpanded
                ? <ChevronDown  className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </div>

      {/* Diff */}
      {showDiff && (
        <div className="border-t border-border bg-muted/20 px-4 py-3">
          {/* entity-history's query selects a.status unconditionally (unlike
              listPending, which never includes it), so a still-pending row
              reaches this component with status="pending" too — only
              "approved"/"rejected" actually mean this approval was resolved. */}
          {(approval.status === "approved" || approval.status === "rejected") && (
            <div className="mb-2 text-xs text-muted-foreground">
              {approval.status === "approved" ? "Approved" : "Rejected"} by{" "}
              <span className="font-medium text-foreground">{approval.approved_by_name ?? "—"}</span>
              {approval.approved_on && <> on {fmtDate(approval.approved_on)}</>}
              {approval.status === "rejected" && approval.remarks && (
                <p className="mt-1.5 rounded-md border border-red-100 bg-red-50 px-2.5 py-1.5 text-red-700">
                  {approval.remarks}
                </p>
              )}
            </div>
          )}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {isBulk ? "Uploaded File" : isBom ? "Formulation Changes" : "Field Changes"}
          </p>
          {isBulk ? (
            <CsvFileCard
              approvalId={approval.id}
              items={approval.items}
              onOpen={onOpenCsvFile}
            />
          ) : isBom ? (
            <BomLineDiffTable items={approval.items} materialMap={materialMap} />
          ) : (
            <FieldDiffTable items={approval.items} />
          )}
        </div>
      )}

      {/* Actions footer */}
      {isApprover && (
        <div
          className={`flex items-center justify-between px-4 py-2 border-t ${showDiff ? "border-border bg-muted/10" : "border-border/40"}`}
          onClick={e => e.stopPropagation()}
        >
          <div>{error && <p className="text-xs text-destructive">{error}</p>}</div>
          <ApprovalActions loading={loading} onApprove={onApprove} onReject={onReject} />
        </div>
      )}
    </div>
  )
}
