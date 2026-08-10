import type{ MasterField } from "@/components/masters/field-config"

/** Pure format check — no DB round-trip needed, unlike the code-existence and
 *  RM%-total checks in app/api/masters/bom-master/route.ts's check_duplicates
 *  action. Rejects both malformed strings ("abc") and impossible calendar
 *  dates ("2026-13-45", "2026-02-30"). */
function validateDateStr(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `must be YYYY-MM-DD (got "${raw}")`
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return `is not a valid calendar date (got "${raw}")`
  }
  return null
}

export const BOM_BULK_CSV_FIELDS: MasterField[] = [
  { key: "sku_code", label: "SKU Code", required: true, placeholder: "e.g. SKU-001", sample: "SKU-001" },
  { key: "bom_code", label: "BOM Code", placeholder: "Auto-generated if blank", sample: "" },
  {
    key: "effective_from", label: "Effective From", required: true,
    placeholder: "YYYY-MM-DD (once per SKU group)", sample: "2026-01-01",
    validate: validateDateStr,
  },
  {
    key: "mtrl_type", label: "Material Type", type: "select", required: true, sample: "rm",
    options: [
      { value: "rm", label: "RM" },
      { value: "pm", label: "PM" },
    ],
    validate: (raw) =>
      ["rm", "pm"].includes(raw.trim().toLowerCase()) ? null : `must be "rm" or "pm" (got "${raw}")`,
  },
  { key: "mtrl_code", label: "Material Code", required: true, placeholder: "e.g. RM-001", sample: "RM-001" },
  {
    key: "amount", label: "Amount", type: "number", required: true, placeholder: "e.g. 45.5", sample: "45.5",
    validate: (raw) =>
      Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  { key: "uom", label: "UOM", placeholder: "e.g. kg", sample: "kg" },
  {
    key: "reason", label: "Reason for Change",
    placeholder: "Required if the SKU already has a BOM (once per SKU group)", sample: "",
  },
  {
    key: "change_type", label: "Type of Change", type: "select",
    placeholder: "Required if the SKU already has a BOM", sample: "",
    options: [
      { value: "rm", label: "RM change" },
      { value: "pm", label: "PM change" },
      { value: "both", label: "RM + PM change" },
    ],
    validate: (raw) =>
      raw.trim() === "" || ["rm", "pm", "both"].includes(raw.trim().toLowerCase())
        ? null
        : `must be "rm", "pm", or "both" (got "${raw}")`,
  },
]
