"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Check, X, Clock, FileText, ExternalLink, Loader2 as SpinIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import type { Approval } from "./approvals-types"
import { MODULE_LABEL, MODULE_COLOR, BULK_MODULES, HISTORY_STATUS_COLOR, isNewRecord, getInitials, fmtDate } from "./approvals-types"

/** RM/PM id → { code, name }, used to resolve a BOM line's bare mtrl_id.
 *  Split by type since rm/pm ids are independent sequences and can collide. */
export type MaterialMap = {
  rm: Record<number, { code: string | null; name: string }>
  pm: Record<number, { code: string | null; name: string }>
}

// ── DiffTable ─────────────────────────────────────────────────────────────────
// Shared red/green "Old Value → New Value" comparison table used by every
// approval type below (field diffs, BOM lines, bulk CSV upload) so all
// approval kinds read the same way instead of each inventing its own layout.

type DiffRow = {
  key: string
  label: string
  old: React.ReactNode
  new: React.ReactNode
  /** Full-width row (e.g. "line removed") instead of the old/new columns. */
  fullWidth?: React.ReactNode
}

/** When every row has no prior value, this is a brand-new record — skip the
 *  Old Value column entirely instead of showing a column full of "—". */
function DiffTable({ rows, newOnly }: { rows: DiffRow[]; newOnly?: boolean }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-muted/40">
            <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">Field</TableHead>
            {!newOnly && <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">Old Value</TableHead>}
            <TableHead className="h-7 text-[10px] font-semibold uppercase tracking-wide">{newOnly ? "Value" : "New Value"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key} className="hover:bg-transparent">
              <TableCell className="py-1.5 text-xs font-medium capitalize text-foreground w-[28%] align-top">
                {r.label}
              </TableCell>
              {r.fullWidth ? (
                <TableCell colSpan={newOnly ? 1 : 2} className="py-1.5 text-xs align-top">
                  {r.fullWidth}
                </TableCell>
              ) : (
                <>
                  {!newOnly && (
                    <TableCell className="py-1.5 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-400 font-medium align-top">
                      {r.old}
                    </TableCell>
                  )}
                  <TableCell className="py-1.5 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-400 font-medium align-top">
                    {r.new}
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── CsvFileCard — rendered as a one-row DiffTable so the bulk upload reads the
//    same as every other approval kind (Field | Old Value | New Value). ──────

function CsvFileCard({ approvalId, items, onOpen }: {
  approvalId: number
  items:      Approval["items"]
  onOpen:     (approvalId: number, s3Key: string, filename: string) => void
}) {
  const filename = items.find(i => i.field_name === "filename")?.new_value ?? "bulk-upload.csv"
  const s3Key    = items.find(i => i.field_name === "s3_key")?.new_value    ?? ""

  return (
    <DiffTable
      rows={[
        {
          key: "csv",
          label: "CSV File",
          old: "—",
          new: (
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{filename}</span>
              {s3Key && (
                <button
                  onClick={() => onOpen(approvalId, s3Key, filename)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white/60 px-2 py-1 text-[11px] font-medium hover:bg-white transition-colors shrink-0 dark:bg-black/20 dark:border-emerald-900"
                >
                  <ExternalLink className="h-3 w-3" /> Preview
                </button>
              )}
            </div>
          ),
        },
      ]}
    />
  )
}

// ── Doc key fields — rendered as view buttons instead of raw S3 keys ──────────

const DOC_FIELDS = new Set([
  "gst_certificate_key", "cancelled_cheque_key", "pan_card_key", "misc_document_key",
])

function DocViewButton({ s3Key, variant }: { s3Key: string; variant: "old" | "new" }) {
  const [opening, setOpening] = useState(false)
  const [failed,  setFailed]  = useState(false)

  async function handleView() {
    setOpening(true)
    setFailed(false)
    try {
      const res  = await fetch(`/api/files/presign?key=${encodeURIComponent(s3Key)}`)
      const data = await res.json()
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer")
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  const filename = s3Key.split("/").pop() ?? s3Key
  const isOld    = variant === "old"

  return (
    <button
      onClick={handleView}
      disabled={opening}
      title={s3Key}
      className={[
        "flex-1 min-w-0 flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors",
        isOld
          ? "bg-red-50 border-red-100 text-red-700 hover:bg-red-100"
          : "bg-emerald-50 border-emerald-100 text-emerald-700 hover:bg-emerald-100",
        "disabled:opacity-60",
      ].join(" ")}
    >
      {opening
        ? <SpinIcon className="h-3 w-3 shrink-0 animate-spin" />
        : <ExternalLink className="h-3 w-3 shrink-0" />
      }
      <span className="truncate">{failed ? "Error opening" : filename}</span>
    </button>
  )
}

// ── FieldDiffTable ────────────────────────────────────────────────────────────

function FieldDiffTable({ items }: { items: Approval["items"] }) {
  const newOnly = isNewRecord(items)
  const rows: DiffRow[] = items.map((item) => {
    const isDoc = DOC_FIELDS.has(item.field_name)
    const label = item.field_name.replace(/_key$/, "").replace(/_/g, " ")

    return {
      key: item.field_name,
      label,
      old: isDoc && item.old_value ? <DocViewButton s3Key={item.old_value} variant="old" /> : (item.old_value || "—"),
      new: isDoc && item.new_value ? <DocViewButton s3Key={item.new_value} variant="new" /> : (item.new_value || "—"),
    }
  })

  return <DiffTable rows={rows} newOnly={newOnly} />
}

// ── BomLineDiffTable — readable rendering of a BOM's line:<type>:<id>:<field>
//    flat approval_items (see lib/approvals/module-handlers.ts bomHandler for
//    the write side). Groups items by material, one row per line, instead of
//    ~40 raw flat FieldDiffGrid cells. ─────────────────────────────────────────

type BomLineRowDiff = {
  mtrlType: "rm" | "pm"
  mtrlId: string
  removed: boolean
  fields: Record<string, { old: string; new: string }>
}

function parseBomApprovalItems(items: Approval["items"]) {
  const modeItem = items.find((i) => i.field_name === "__mode__")
  const mode = modeItem?.new_value === "update-existing" ? "update-existing" : "new-version"

  const lineMap = new Map<string, BomLineRowDiff>()
  for (const it of items) {
    const m = it.field_name.match(/^line:(rm|pm):(\d+):(.+)$/)
    if (!m) continue
    const [, mtrlType, mtrlId, field] = m
    const key = `${mtrlType}:${mtrlId}`
    if (!lineMap.has(key)) {
      lineMap.set(key, { mtrlType: mtrlType as "rm" | "pm", mtrlId, removed: false, fields: {} })
    }
    const entry = lineMap.get(key)!
    if (field === "__removed__") entry.removed = true
    else entry.fields[field] = { old: it.old_value, new: it.new_value }
  }
  return { mode, lines: [...lineMap.values()] }
}

function materialLabel(mtrlType: "rm" | "pm", mtrlId: string, materialMap?: MaterialMap) {
  const mat = materialMap?.[mtrlType]?.[Number(mtrlId)]
  if (!mat) return `${mtrlType.toUpperCase()} #${mtrlId}`
  return `${mat.code ?? `#${mtrlId}`} — ${mat.name}`
}

function BomLineDiffTable({ items, materialMap }: { items: Approval["items"]; materialMap?: MaterialMap }) {
  const { mode, lines } = parseBomApprovalItems(items)
  const rmLines = lines.filter((l) => l.mtrlType === "rm")
  const pmLines = lines.filter((l) => l.mtrlType === "pm")

  function renderLine(line: BomLineRowDiff) {
    const label = materialLabel(line.mtrlType, line.mtrlId, materialMap)

    if (line.removed) {
      return (
        <div key={`${line.mtrlType}:${line.mtrlId}`}>
          <DiffTable
            rows={[{
              key: "removed",
              label,
              old: "",
              new: "",
              fullWidth: (
                <span className="text-red-700 dark:text-red-400 font-medium line-through">
                  Line removed
                </span>
              ),
            }]}
          />
        </div>
      )
    }

    const rows: DiffRow[] = Object.entries(line.fields).map(([field, { old: oldVal, new: newVal }]) => ({
      key: field,
      label: field.replace(/_/g, " "),
      old: oldVal || "—",
      new: newVal || "—",
    }))

    return (
      <div key={`${line.mtrlType}:${line.mtrlId}`} className="space-y-1">
        <p className="text-xs font-semibold">{label}</p>
        <DiffTable rows={rows} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Badge variant="secondary" className="text-[10px]">
        {mode === "new-version" ? "New Version" : "Update Existing"}
      </Badge>
      {rmLines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            RM ({rmLines.length})
          </p>
          {rmLines.map(renderLine)}
        </div>
      )}
      {pmLines.length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            PM ({pmLines.length})
          </p>
          {pmLines.map(renderLine)}
        </div>
      )}
    </div>
  )
}

// ── EntityInfo ────────────────────────────────────────────────────────────────

function EntityInfo({ approval }: { approval: Approval }) {
  const { entity_code, entity_name, entity_secondary_code, entity_secondary_name, entity_id } = approval

  if (!entity_code && !entity_name) {
    return <span className="font-mono text-xs text-muted-foreground">#{entity_id}</span>
  }

  // Name leads (the team scans by name, not code) — code follows as a small
  // muted monospace tag instead of the other way round.
  return (
    <div className="space-y-0.5">
      <div>
        {entity_name && (
          <span className="text-sm font-medium">
            {entity_name}
          </span>
        )}
        {entity_code && (
          <span className={`font-mono text-xs text-muted-foreground ${entity_name ? "ml-2" : "text-sm font-bold tracking-tight text-foreground"}`}>
            {entity_code}
          </span>
        )}
      </div>
      {(entity_secondary_code || entity_secondary_name) && (
        <div>
          {entity_secondary_name && (
            <span className="text-xs text-muted-foreground">
              {entity_secondary_name}
            </span>
          )}
          {entity_secondary_code && (
            <span className={`font-mono text-xs text-muted-foreground ${entity_secondary_name ? "ml-1.5" : ""}`}>
              {entity_secondary_code}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── ApprovalRow — one table row per approval, used on /approvals so a module
//    group reads as a scannable table instead of a stack of cards. Skips the
//    module badge entirely: the group header and New/Edits/Bulk Uploads
//    section label above already say what these rows are. ────────────────────

/** One field per line, label column aligned — legible at a glance instead of
 *  chips wrapped edge-to-edge across the row. */
function ChangesSummary({ items }: { items: Approval["items"] }) {
  const newOnly = isNewRecord(items)
  return (
    <div className="rounded-md border border-border/60 divide-y divide-border/60 overflow-hidden text-[11px] max-w-md">
      {items.map((item) => {
        const isDoc = DOC_FIELDS.has(item.field_name)
        const label = item.field_name.replace(/_key$/, "").replace(/_/g, " ")
        return (
          <div key={item.field_name} className="flex items-center gap-2 px-2 py-1 bg-card">
            <span className="w-24 shrink-0 font-medium capitalize text-muted-foreground truncate">{label}</span>
            {isDoc ? (
              item.new_value
                ? <DocViewButton s3Key={item.new_value} variant="new" />
                : <span className="text-muted-foreground">—</span>
            ) : newOnly ? (
              <span className="min-w-0 truncate font-medium text-emerald-700 dark:text-emerald-400">{item.new_value || "—"}</span>
            ) : (
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-red-600 dark:text-red-400 line-through">{item.old_value || "—"}</span>
                <span className="shrink-0 text-muted-foreground">→</span>
                <span className="min-w-0 truncate font-medium text-emerald-700 dark:text-emerald-400">{item.new_value || "—"}</span>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CsvSummary({ approvalId, items, onOpen }: {
  approvalId: number
  items:      Approval["items"]
  onOpen:     (approvalId: number, s3Key: string, filename: string) => void
}) {
  const filename  = items.find(i => i.field_name === "filename")?.new_value ?? "bulk-upload.csv"
  const s3Key     = items.find(i => i.field_name === "s3_key")?.new_value ?? ""
  const rowCount  = items.find(i => i.field_name === "row_count")?.new_value

  return (
    <div className="flex items-center gap-2 text-xs">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{filename}</span>
      {rowCount && <Badge variant="secondary" className="text-[10px] h-4 shrink-0">{rowCount} rows</Badge>}
      {s3Key && (
        <button
          onClick={() => onOpen(approvalId, s3Key, filename)}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium hover:bg-emerald-100 transition-colors shrink-0 dark:bg-emerald-950/30 dark:border-emerald-900"
        >
          <ExternalLink className="h-3 w-3" /> Preview
        </button>
      )}
    </div>
  )
}

export function ApprovalRow({
  approval, isApprover, loading, error, onApprove, onReject, onOpenCsvFile,
}: {
  approval:      Approval
  isApprover:    boolean
  loading:       boolean
  error?:        string
  onApprove:     () => void
  onReject:      () => void
  onOpenCsvFile: (approvalId: number, s3Key: string, filename: string) => void
}) {
  const isBulk = BULK_MODULES.has(approval.module)

  return (
    <TableRow className="hover:bg-muted/20 align-top">
      <TableCell className="py-2 align-top w-[22%]">
        <EntityInfo approval={approval} />
      </TableCell>
      <TableCell className="py-2 align-top">
        {isBulk
          ? <CsvSummary approvalId={approval.id} items={approval.items} onOpen={onOpenCsvFile} />
          : <ChangesSummary items={approval.items} />
        }
      </TableCell>
      <TableCell className="py-2 align-top w-[16%]">
        <div className="flex items-center gap-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground select-none shrink-0">
            {getInitials(approval.raised_by_name)}
          </div>
          <span className="text-xs font-medium truncate">{approval.raised_by_name}</span>
        </div>
        <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0" />
          {fmtDate(approval.raised_on)}
        </div>
      </TableCell>
      {isApprover && (
        <TableCell className="py-2 align-top w-px whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm" variant="outline" disabled={loading}
              className="h-6 gap-1 text-[11px] text-red-700 border-red-200 hover:bg-red-50"
              onClick={onReject}
            >
              <X className="h-3 w-3" /> Reject
            </Button>
            <Button
              size="sm" disabled={loading}
              className="h-6 gap-1 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white border-0"
              onClick={onApprove}
            >
              <Check className="h-3 w-3" /> Approve
            </Button>
          </div>
          {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
        </TableCell>
      )}
    </TableRow>
  )
}

// ── ApprovalCard ──────────────────────────────────────────────────────────────

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
          {approval.status && (
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
          <div className="flex items-center gap-1.5">
            <Button
              size="sm" variant="outline" disabled={loading}
              className="h-6 gap-1 text-[11px] text-red-700 border-red-200 hover:bg-red-50"
              onClick={onReject}
            >
              <X className="h-3 w-3" /> Reject
            </Button>
            <Button
              size="sm" disabled={loading}
              className="h-6 gap-1 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white border-0"
              onClick={onApprove}
            >
              <Check className="h-3 w-3" /> Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
