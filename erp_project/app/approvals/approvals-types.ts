export type ApprovalItem = {
  field_name: string
  old_value: string
  new_value: string
}

export type Approval = {
  id: number
  module: string
  entity_id: number
  raised_on: string
  raised_by_name: string
  items: ApprovalItem[]
  entity_code: string | null
  entity_name: string | null
  entity_secondary_code: string | null
  entity_secondary_name: string | null
  /** "create" | "edit" | "delete" — null for older rows predating the column. */
  approval_type?: string | null
  /** Present only on /approvals/history rows — resolved approvals. */
  status?: "approved" | "rejected"
  approved_by_name?: string | null
  approved_on?: string | null
  remarks?: string | null
  /** The submitter's free-text reason for this specific edit, resolved from
   *  history_masters_edits by entity-history/route.ts — only present for
   *  modules that call insertHistoryEntry (MFG, VENDOR, RM_MAT, PM_MAT, SKU). */
  reason?: string | null
}

/** True when this approval created the record rather than editing it —
 *  prefers the real approval_type column, falling back to the "every changed
 *  field has no prior value" heuristic for rows predating that column. */
export function isCreateApproval(approval: Pick<Approval, "approval_type" | "items">) {
  if (approval.approval_type) return approval.approval_type === "create"
  return isNewRecord(approval.items)
}

export const MODULE_LABEL: Record<string, string> = {
  SKU: "SKU",
  RM_RATE: "RM Rate (MFG)",
  PM_RATE: "PM Rate (MFG)",
  RM_VRM: "RM Rate (Vendor)",
  PM_VRM: "PM Rate (Vendor)",
  RM_MAT: "Raw Material",
  PM_MAT: "Packing Material",
  VENDOR: "Vendor",
  MFG: "Manufacturer",
  PO: "Impromptu PO",
  PO_BULK: "Bulk PO Upload",
  VENDOR_BULK: "Bulk Vendor Upload",
  MFG_BULK: "Bulk Manufacturer Upload",
  RM_BULK: "Bulk RM Upload",
  PM_BULK: "Bulk PM Upload",
  // Registered in MODULE_HANDLERS since the rate-bulk flows shipped, but never
  // added here — an approval of one rendered its raw code as the label.
  RM_VRM_BULK:  "Bulk RM Rate (Vendor) Upload",
  RM_RATE_BULK: "Bulk RM Rate (MFG) Upload",
  PM_VRM_BULK:  "Bulk PM Rate (Vendor) Upload",
  PM_RATE_BULK: "Bulk PM Rate (MFG) Upload",
  // Keys are the module codes stored in `approvals.module` — 14 existing rows
  // use them, so they stay "BOM" until those are migrated. Only the labels,
  // which are what users read, become Recipe.
  BOM: "Recipe",
  BOM_BULK: "Bulk Recipe Upload",
  MFG_MISC: "Misc. Cost (MFG)",
  MFG_MISC_BULK: "Bulk Misc. Cost Upload",
}

/** Modules whose approval_items store {s3_key, filename, row_count} for a
 *  whole uploaded batch instead of a field-level diff — see the CsvFileCard
 *  branch in ApprovalCard.tsx and the *_BULK handlers in
 *  lib/approvals/module-handlers.ts. */
export const BULK_MODULES = new Set([
  "PO_BULK", "VENDOR_BULK", "MFG_BULK", "RM_BULK", "PM_BULK", "BOM_BULK",
  // Rate bulks store the same {s3_key, filename, row_count} shape. Their
  // absence here made an approval of one render a field diff over those three
  // internal keys instead of the CSV file card.
  "RM_VRM_BULK", "RM_RATE_BULK", "PM_VRM_BULK", "PM_RATE_BULK",
  "MFG_MISC_BULK",
])

/** Maps a *_BULK module code to the base module it belongs to, so bulk
 *  uploads and regular edits for the same entity group under one section
 *  (e.g. "Bulk Manufacturer Upload" + "Manufacturer" → one "Manufacturer" group)
 *  instead of splitting into two separate module rows. */
const BULK_GROUP_KEY: Record<string, string> = {
  MFG_BULK:    "MFG",
  VENDOR_BULK: "VENDOR",
  RM_BULK:     "RM_MAT",
  PM_BULK:     "PM_MAT",
  PO_BULK:     "PO",
  BOM_BULK:    "BOM",
  RM_VRM_BULK:  "RM_VRM",
  RM_RATE_BULK: "RM_RATE",
  PM_VRM_BULK:  "PM_VRM",
  PM_RATE_BULK: "PM_RATE",
  MFG_MISC_BULK: "MFG_MISC",
}

export function groupKeyFor(module: string) {
  return BULK_GROUP_KEY[module] ?? module
}

/** True when every changed field has no prior value — i.e. this approval
 *  creates a brand-new record rather than editing an existing one. */
export function isNewRecord(items: ApprovalItem[]) {
  return items.length > 0 && items.every(i => !i.old_value || i.old_value === "-")
}

export const MODULE_COLOR: Record<string, string> = {
  SKU: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900/40",
  RM_RATE: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-400 dark:border-purple-900/40",
  PM_RATE: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900/40",
  RM_VRM: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-900/40",
  PM_VRM: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/30 dark:text-teal-400 dark:border-teal-900/40",
  RM_MAT: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900/40",
  PM_MAT: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-900/40",
  VENDOR: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-900/40",
  MFG: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
  PO: "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-900/40",
  PO_BULK: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-400 dark:border-cyan-900/40",
  VENDOR_BULK: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-900/40",
  MFG_BULK: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
  RM_BULK: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900/40",
  PM_BULK: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-900/40",
  BOM: "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-400 dark:border-lime-900/40",
  BOM_BULK: "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-400 dark:border-lime-900/40",
  // Rate bulks borrow their base module's swatch, so a bulk and a single edit
  // of the same thing read as the same colour.
  RM_VRM_BULK:  "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-900/40",
  RM_RATE_BULK: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-400 dark:border-purple-900/40",
  PM_VRM_BULK:  "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/30 dark:text-teal-400 dark:border-teal-900/40",
  PM_RATE_BULK: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900/40",
  // Misc. costs sit alongside the manufacturer's agreed rates, so they borrow
  // MFG's amber — and the bulk borrows the single, as every other pair does.
  MFG_MISC:      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
  MFG_MISC_BULK: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
}

/** Fallback swatch for a module with no entry above — kept alongside
 *  MODULE_COLOR since every consumer falls back to this same string. */
export const MODULE_COLOR_FALLBACK =
  "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700/40"

export function getInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2)
}

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    // Explicit IST — don't rely on the host process's local timezone, which
    // differs between dev machines and deployment targets.
    timeZone: "Asia/Kolkata",
  })
}
