import type { MasterField } from "@/components/masters/field-config"
import { STATUS_CONFIG, STATUS_KEYS } from "./po-types"

// Same format check as app/masters/bom-master/bom-bulk-fields.ts — pure
// string validation, no DB round-trip needed here.
function validateDateStr(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `must be YYYY-MM-DD (got "${raw}")`
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    return `is not a valid calendar date (got "${raw}")`
  }
  return null
}

// "rejected" is an approval-outcome state, not something a human should type
// into a CSV — STATUS_KEYS already excludes it (see po-types.ts).
const STATUS_OPTIONS = STATUS_KEYS.map((k) => ({ value: k, label: STATUS_CONFIG[k].label }))

/**
 * Same columns the "Download CSV" export produces (see
 * lib/export-configs.ts's PO_PROCUREMENT_EXPORT_COLUMNS) plus a couple only
 * the importer cares about — download, edit, re-upload the same file.
 * Extra export-only columns (mfg_name, sku_name, sku_status, received_qty,
 * unit_price, total_amount, invoice_no, po_type) aren't declared here, so
 * they're simply ignored on import rather than rejected.
 *
 * IMPORTANT: the export writes each column's human-readable *label* as the
 * CSV header (e.g. "PO No.", "Mfg Code", "SKU", "PO Qty", "Expected
 * Dispatch" — see lib/export.ts's buildCsv), not the field `key`. The
 * `aliases` below are exactly those export labels (lowercased) so a
 * downloaded-then-reuploaded file matches on `key` OR `aliases` either way —
 * see buildRows in components/masters/field-config.ts.
 *
 * Row semantics (see poBulkHandler.applyAndArchive):
 *   po_no blank/unrecognized → CREATE a new PO (mfg_code, sku_code, bom_code, qty required)
 *   po_no matches an existing PO → UPDATE that PO's status/expected_on/destination only
 *     (bom_code is still required, but only as a cross-check against the PO —
 *      it is written only when the PO doesn't have one yet)
 */
export const PO_BULK_CSV_FIELDS: MasterField[] = [
  { key: "po_no", label: "PO No.", aliases: ["po no."], placeholder: "Blank = create new PO", sample: "" },
  { key: "mfg_code", label: "Mfg Code", aliases: ["mfg code"], required: true, placeholder: "e.g. MFG-001-ABC", sample: "MFG-001-ABC" },
  { key: "sku_code", label: "SKU", aliases: ["sku"], required: true, placeholder: "e.g. SKU-001", sample: "SKU-001" },
  {
    // Which recipe the PO is against. Required on every row, including updates:
    // the importer uses it to confirm the row is talking about the same PO the
    // po_no points at, and backfills it on POs raised before this column existed.
    key: "bom_code", label: "BOM Code", aliases: ["bom code"], required: true,
    placeholder: "e.g. BOM-SKU-001-R1-P1", sample: "BOM-SKU-001-R1-P1",
  },
  {
    key: "qty", label: "PO Qty", aliases: ["po qty"], type: "number", required: true, placeholder: "e.g. 5000", sample: "5000",
    validate: (raw) =>
      Number.isFinite(Number(raw)) && Number(raw) > 0 ? null : `must be a positive number (got "${raw}")`,
  },
  {
    key: "expected_on", label: "Expected Dispatch", aliases: ["expected dispatch"], placeholder: "YYYY-MM-DD", sample: "",
    validate: validateDateStr,
  },
  { key: "destination", label: "Destination", placeholder: "e.g. Gurgaon", sample: "" },
  {
    key: "status", label: "Status", type: "select", sample: "",
    options: STATUS_OPTIONS,
    validate: (raw) =>
      STATUS_KEYS.includes(raw.trim().toLowerCase()) ? null : `must be one of ${STATUS_KEYS.join(", ")} (got "${raw}")`,
  },
]
