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
  /** Present only on /approvals/history rows — resolved approvals. */
  status?: "approved" | "rejected"
  approved_by_name?: string | null
  approved_on?: string | null
  remarks?: string | null
}

export const HISTORY_STATUS_COLOR: Record<string, string> = {
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
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
  // Keys are the module codes stored in `approvals.module` — 14 existing rows
  // use them, so they stay "BOM" until those are migrated. Only the labels,
  // which are what users read, become Recipe.
  BOM: "Recipe",
  BOM_BULK: "Bulk Recipe Upload",
}

/** Modules whose approval_items store {s3_key, filename, row_count} for a
 *  whole uploaded batch instead of a field-level diff — see the CsvFileCard
 *  branch in ApprovalCard.tsx and the *_BULK handlers in
 *  lib/approvals/module-handlers.ts. */
export const BULK_MODULES = new Set([
  "PO_BULK", "VENDOR_BULK", "MFG_BULK", "RM_BULK", "PM_BULK", "BOM_BULK",
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
  SKU: "bg-blue-50 text-blue-700 border-blue-200",
  RM_RATE: "bg-purple-50 text-purple-700 border-purple-200",
  PM_RATE: "bg-orange-50 text-orange-700 border-orange-200",
  RM_VRM: "bg-green-50 text-green-700 border-green-200",
  PM_VRM: "bg-teal-50 text-teal-700 border-teal-200",
  RM_MAT: "bg-rose-50 text-rose-700 border-rose-200",
  PM_MAT: "bg-violet-50 text-violet-700 border-violet-200",
  VENDOR: "bg-indigo-50 text-indigo-700 border-indigo-200",
  MFG: "bg-amber-50 text-amber-700 border-amber-200",
  PO: "bg-yellow-50 text-yellow-700 border-yellow-200",
  PO_BULK: "bg-cyan-50 text-cyan-700 border-cyan-200",
  VENDOR_BULK: "bg-indigo-50 text-indigo-700 border-indigo-200",
  MFG_BULK: "bg-amber-50 text-amber-700 border-amber-200",
  RM_BULK: "bg-rose-50 text-rose-700 border-rose-200",
  PM_BULK: "bg-violet-50 text-violet-700 border-violet-200",
  BOM: "bg-lime-50 text-lime-700 border-lime-200",
  BOM_BULK: "bg-lime-50 text-lime-700 border-lime-200",
}

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
