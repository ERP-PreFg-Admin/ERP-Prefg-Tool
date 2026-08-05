"use client"

/**
 * Shared building blocks for rendering one field's old→new diff — used by
 * every diff renderer in the app (FieldDiffTable's boxed table, ApprovalRow's
 * compact ChangesSummary, HistoryEntry's ChangesCell). Each of those keeps
 * its own layout (table cells vs. bordered list vs. inline flex-wrap — a
 * real density difference depending on the context), but they were each
 * independently re-implementing "is this a doc-key field, and if not, what
 * color/strikethrough does old vs. new get" — which is how the old/new
 * colors drifted (red-600 vs red-600/80, line-through applied inconsistently).
 */

import { cn } from "@/lib/utils"
import { DOC_FIELDS, DocViewButton } from "./DocViewButton"
import { DIFF_OLD_TEXT_CLASS, DIFF_NEW_TEXT_CLASS } from "./diff-colors"

export { DIFF_OLD_TEXT_CLASS, DIFF_NEW_TEXT_CLASS, DIFF_OLD_CELL_CLASS, DIFF_NEW_CELL_CLASS } from "./diff-colors"

/** Shared rejection-remarks callout — used wherever a rejected approval's
 *  reason is shown (the approvals queue card, the entity History table). */
export function RejectionRemarksCallout({ remarks, dense = false }: { remarks: string; dense?: boolean }) {
  return (
    <p
      className={cn(
        "border border-red-100 bg-red-50 dark:border-red-900/40 dark:bg-red-950/30",
        DIFF_OLD_TEXT_CLASS,
        dense ? "rounded px-1.5 py-1 text-[11px]" : "mt-1.5 rounded-md px-2.5 py-1.5 text-xs"
      )}
    >
      {remarks}
    </p>
  )
}

/** "gst_certificate_key" → "gst certificate"; "email" → "email". */
export function formatFieldLabel(fieldName: string): string {
  return fieldName.replace(/_key$/, "").replace(/_/g, " ")
}

/**
 * Renders one side of a field's diff value.
 * - Doc-key fields always resolve to a DocViewButton, regardless of `plain`.
 * - `plain` (default false) skips the color/strikethrough styling — for
 *   contexts like FieldDiffTable, where the surrounding table cell already
 *   carries the red/emerald background and text color.
 */
export function DiffFieldValue({ fieldName, value, variant, plain = false }: {
  fieldName: string
  value: string
  variant: "old" | "new"
  plain?: boolean
}) {
  if (DOC_FIELDS.has(fieldName) && value) {
    return <DocViewButton s3Key={value} variant={variant} />
  }
  if (plain) return <>{value || "—"}</>
  return variant === "old"
    ? <span className={cn(DIFF_OLD_TEXT_CLASS, "line-through")}>{value || "—"}</span>
    : <span className={cn(DIFF_NEW_TEXT_CLASS, "font-medium")}>{value || "—"}</span>
}
