// Every export column must name a field the report's rows actually carry, or the file gets a blank column.
// Samples are typed against the service row types, so a renamed field fails tsc here too.

import {
  FILL_RATE_EXPORT, INVOICE_EXCEPTIONS_EXPORT, OPEN_PO_EXPORT, RATE_VARIANCE_EXPORT, DQ_ROWS_EXPORT,
} from "@/lib/reports/export-columns"
import type { OpenPoRow } from "@/lib/services/reports/open-po"
import type { InvoiceExceptionRow, RateLineRow } from "@/lib/services/reports/invoice-checks"
import type { DqRow } from "@/lib/services/reports/data-quality"
import type { FillRow } from "@/lib/reports/fill-rate"
import { buildCsv } from "@/lib/export"
import { test } from "node:test"
import assert from "node:assert/strict"

const openPo: OpenPoRow = {
  id: 1, po_no: "PO-1", po_type: "normal", date: "2026-10-01", expected_on: "2026-10-20", destination: "Mumbai",
  sku_code: "S1", sku_name: "Soap", brand_name: "B", mfg_code: "M1", mfg_name: "Mfg", qty: 10, received_qty: 4,
  open_qty: 6, unit_price: 5, open_value_pre_gst: 30, open_value_incl_gst: 35.4, price_class: "priced",
  display_status: "raised", child_count: 0, age_days: 25, age_bucket: "0-30", overdue: true,
}
const fill: FillRow = {
  key: "M1|2026-10", mfg_code: "M1", mfg_name: "Mfg", month: "2026-10", pos: 1, ordered: 10, received: 4, fill_pct: 40,
  closed_short: 0, still_open: 6, over_received_pos: 0, lead_n: 1, lead_median: 9, lead_p90: 9, on_time_n: 1, on_time_pct: 100,
}
const exception: InvoiceExceptionRow = {
  id: 1, invoice_no: "INV-1", invoice_date: "2026-10-01", inwarded_on: "2026-10-02", age_days: 24, destination: "Mumbai",
  mfg_code: "M1", mfg_name: "Mfg", invoice_total: 100, lines_value: 118, total_gap: 18, billed_qty: 10, grn_accepted: 9,
  grn_rejected: 1, grn_rejected_value: 5, uniware_synced_on: null, badge: "variance", label: "Variance", reason: "why",
  legs: { po: "ok", inv: "variance", grn: "missing" }, payment: "Blocked",
}
const rate: RateLineRow = {
  id: 1, invoice_id: 1, invoice_no: "INV-1", invoice_date: "2026-10-01", inwarded_on: "2026-10-02", mfg_code: "M1",
  mfg_name: "Mfg", sku_code: "S1", sku_name: "Soap", po_no: "PO-1", qty: 10, invoice_rate: 105, po_rate: 100,
  diff_pct: 5, value_at_risk: 50,
}
const dq: DqRow = { ref: "PO-1", label: "M1 · S1", sub: "2026-10-01", detail: "qty 10" }

for (const [name, cols, row] of [
  ["open PO book", OPEN_PO_EXPORT, openPo],
  ["fill rate", FILL_RATE_EXPORT, fill],
  ["invoice exceptions", INVOICE_EXCEPTIONS_EXPORT, exception],
  ["rate vs PO", RATE_VARIANCE_EXPORT, rate],
  ["data quality rows", DQ_ROWS_EXPORT, dq],
] as const) {
  test(`${name}: every export column names a field of the row`, () => {
    const missing = cols.map((c) => c.key).filter((k) => !(k in row))
    assert.deepEqual(missing, [])
  })
}

test("formatted cells render: legs and the overdue flag", () => {
  const csv = buildCsv(INVOICE_EXCEPTIONS_EXPORT, [exception as unknown as Record<string, unknown>])
  assert.ok(csv.includes('"ok / variance / missing"'))
  assert.ok(buildCsv(OPEN_PO_EXPORT, [openPo as unknown as Record<string, unknown>]).includes('"Yes"'))
})
