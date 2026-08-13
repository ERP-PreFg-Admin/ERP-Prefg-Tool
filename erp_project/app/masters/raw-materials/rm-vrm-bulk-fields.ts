import type { MasterField } from "@/components/masters/field-config"

/** Pure format check — no DB round-trip. See app/api/v1/masters/raw-materials/
 *  vrm-bulk/route.ts's check_duplicates action for the code-existence checks. */
function validateDateStr(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `must be YYYY-MM-DD (got "${raw}")`
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return `is not a valid calendar date (got "${raw}")`
  }
  return null
}

export const RM_VRM_BULK_FIELDS: MasterField[] = [
  { key: "rm_code", label: "RM Code", required: true, placeholder: "e.g. RM-0001", sample: "RM-0001" },
  { key: "vendor_code", label: "Vendor Code", required: true, placeholder: "e.g. VEN-RM-ABC-001", sample: "VEN-RM-ABC-001" },
  {
    key: "curr_rate", label: "Rate (₹)", type: "number", required: true, placeholder: "e.g. 120.50", sample: "120.50",
    validate: (raw) => Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  {
    key: "moq", label: "MOQ", type: "number", required: true, placeholder: "e.g. 100", sample: "100",
    validate: (raw) => Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  { key: "uom", label: "UOM", placeholder: "e.g. kg", sample: "kg" },
  {
    key: "effective_from", label: "Effective From", placeholder: "YYYY-MM-DD", sample: "2026-01-01",
    validate: validateDateStr,
  },
  {
    key: "effective_to", label: "Effective To", placeholder: "YYYY-MM-DD", sample: "",
    validate: validateDateStr,
  },
  { key: "mfg_code", label: "Manufacturer Code (optional tag)", placeholder: "e.g. MFG-001", sample: "" },
  { key: "remarks", label: "Remarks", colSpan: 2, placeholder: "Optional for new rates — remarks are required when submitting an edit", sample: "" },
]
