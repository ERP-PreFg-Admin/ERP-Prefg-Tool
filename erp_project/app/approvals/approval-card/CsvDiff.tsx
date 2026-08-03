"use client"

/** Rendering for *_BULK approvals, whose approval_items store
 *  {s3_key, filename, row_count} for a whole uploaded batch instead of a
 *  field-level diff — see BULK_MODULES in approvals-types.ts and the
 *  *_BULK handlers in lib/approvals/module-handlers.ts. */

import { FileText, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Approval } from "../approvals-types"
import { DiffTable } from "./DiffTable"

/** Rendered as a one-row DiffTable so the bulk upload reads the same as
 *  every other approval kind (Field | Old Value | New Value). */
export function CsvFileCard({ approvalId, items, onOpen }: {
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

/** Compact one-line variant for the /approvals table-row view. */
export function CsvSummary({ approvalId, items, onOpen }: {
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
