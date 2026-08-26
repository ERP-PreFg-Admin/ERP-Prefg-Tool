import type { MasterField } from "@/components/masters/field-config"
import { dateCellRemark, parseDateCell } from "@/lib/date"

export const PM_VRM_BULK_FIELDS: MasterField[] = [
  { key: "pm_code", label: "PM Code", required: true, placeholder: "e.g. PM-0001", sample: "PM-0001" },
  { key: "vendor_code", label: "Vendor Code", required: true, placeholder: "e.g. VEN-PM-ABC-001", sample: "VEN-PM-ABC-001" },
  {
    key: "curr_rate", label: "Rate (₹)", type: "number", required: true, placeholder: "e.g. 12.50", sample: "12.50",
    validate: (raw) => Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  {
    key: "moq", label: "MOQ", type: "number", required: true, placeholder: "e.g. 500", sample: "500",
    validate: (raw) => Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  { key: "uom", label: "UOM", placeholder: "e.g. pcs", sample: "pcs" },
  {
    key: "effective_from", label: "Effective From", placeholder: "YYYY-MM-DD", sample: "2026-01-01",
    validate: dateCellRemark, parse: parseDateCell,
  },
  {
    key: "effective_to", label: "Effective To", placeholder: "YYYY-MM-DD", sample: "",
    validate: dateCellRemark, parse: parseDateCell,
  },
  { key: "remarks", label: "Remarks", colSpan: 2, placeholder: "Optional for new rates — remarks are required when submitting an edit", sample: "" },
]
