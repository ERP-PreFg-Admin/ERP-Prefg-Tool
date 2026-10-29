// The chain map (lib/reports/stations.ts): every report and every traceability dataset has a place on it.

import { CHAIN, placeLabel } from "@/lib/reports/stations"
import { REPORTS } from "@/lib/reports/catalog"
import { TRACE_TABS } from "@/lib/reports/trace/contracts"
import { test } from "node:test"
import assert from "node:assert/strict"

test("every catalogue report and every dataset tab is placed on the chain", () => {
  for (const r of REPORTS) assert.ok(CHAIN.some((c) => c.reportId === r.id), `${r.id} has no place`)
  for (const t of TRACE_TABS) assert.ok(CHAIN.some((c) => c.tab === t), `dataset ${t} has no place`)
  for (const c of CHAIN) assert.ok(REPORTS.some((r) => r.id === c.reportId), `${c.key} points at no report`)
  assert.equal(new Set(CHAIN.map((c) => c.key)).size, CHAIN.length, "keys are unique")
})

test("breadcrumbs name the station, or the row", () => {
  assert.equal(placeLabel("open-po-book"), "Ordered")
  assert.equal(placeLabel("invoice-checks"), "Invoiced")
  assert.equal(placeLabel("exceptions"), "Overview")
  assert.equal(placeLabel("trace"), "Whole chain")
  assert.equal(placeLabel("data-quality"), "Upkeep")
  assert.equal(placeLabel("nope"), "Reports")
})
