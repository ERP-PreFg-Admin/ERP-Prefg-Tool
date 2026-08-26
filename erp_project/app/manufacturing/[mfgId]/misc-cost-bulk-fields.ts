import type { MasterField } from "@/components/masters/field-config"
import { dateCellRemark, parseDateCell } from "@/lib/date"

const MISC_COST_TYPE_OPTIONS = [
  { value: "jw", label: "Job Work" },
  { value: "shrink", label: "Shrink Wrap" },
  { value: "shipper", label: "Shipper" },
  { value: "rm_loss", label: "RM Wastage %" },
  { value: "pm_loss", label: "PM Wastage %" },
]
const MISC_COST_TYPE_VALUES = MISC_COST_TYPE_OPTIONS.map((o) => o.value)

export const MISC_COST_BULK_CSV_FIELDS: MasterField[] = [
  { key: "sku_code", label: "SKU Code", required: true, placeholder: "e.g. SKU-001", sample: "SKU-001" },
  {
    key: "type", label: "Type", type: "select", required: true, sample: "jw",
    options: MISC_COST_TYPE_OPTIONS,
    validate: (raw) =>
      MISC_COST_TYPE_VALUES.includes(raw.trim().toLowerCase())
        ? null
        : `must be one of ${MISC_COST_TYPE_VALUES.join(", ")} (got "${raw}")`,
  },
  {
    key: "cost", label: "Cost / Wastage %", type: "number", required: true, placeholder: "e.g. 2.50", sample: "2.50",
    validate: (raw) =>
      Number.isFinite(Number(raw)) && Number(raw) >= 0 ? null : `must be a non-negative number (got "${raw}")`,
  },
  {
    key: "effective_from", label: "Effective From", required: true, placeholder: "YYYY-MM-DD", sample: "2026-01-01",
    validate: dateCellRemark, parse: parseDateCell,
  },
  {
    key: "effective_till", label: "Effective Till", placeholder: "YYYY-MM-DD", sample: "",
    validate: dateCellRemark, parse: parseDateCell,
  },
  {
    key: "status", label: "Status", type: "select", default: "active", sample: "active",
    options: [
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
      { value: "discontinued", label: "Discontinued" },
    ],
  },
]
