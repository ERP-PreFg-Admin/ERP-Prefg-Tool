// Snapshot metrics (lib/reports/snapshot-metrics.ts): exception counts per manufacturer, and trend deltas.

import { exceptionSnapshot, trendDelta, SNAPSHOT_METRICS } from "@/lib/reports/snapshot-metrics"
import type { ExceptionRow } from "@/lib/reports/exception-types"
import { test } from "node:test"
import assert from "node:assert/strict"

const ex = (type: ExceptionRow["type"], mfg: string | null) =>
  ({ type, mfg_code: mfg, label: "", ref: "", detail: "", age_days: 0, value: 1, value_unit: "inr", source: "" }) as ExceptionRow

test("exception counts: overall and per manufacturer; data quality only overall; cleared types read 0", () => {
  const vals = exceptionSnapshot([ex("rate_over_po", "M1"), ex("rate_over_po", "M2"), ex("batch_short", "M1"), ex("data_quality", null)], ["M1", "M2", "M3"])
  const v = (metric: string, mfg: string) => vals.find((x) => x.metric === metric && x.mfg_code === mfg)?.value
  assert.equal(v("exceptions_total", ""), 4)
  assert.equal(v("exceptions_total", "M1"), 2)
  assert.equal(v("exceptions_rate_over_po", "M2"), 1)
  assert.equal(v("exceptions_total", "M3"), 0)
  assert.equal(v("exceptions_data_quality", ""), 1)
  assert.equal(v("exceptions_data_quality", "M1"), undefined, "data quality has no manufacturer")
  for (const m of new Set(vals.map((x) => x.metric))) assert.ok(SNAPSHOT_METRICS.some((d) => d.id === m), m)
})

test("trend delta: vs the nearest day at or before N days back; good follows the metric's direction", () => {
  const s = [{ day: "2026-09-27", value: 100 }, { day: "2026-10-20", value: 80 }, { day: "2026-10-27", value: 70 }]
  assert.deepEqual(trendDelta(s, 7, "down"), { change: -10, good: true })
  assert.deepEqual(trendDelta(s, 30, "up"), { change: -30, good: false })
  assert.equal(trendDelta(s, 365, "up"), null, "no point that far back")
  assert.equal(trendDelta([{ day: "2026-10-27", value: 5 }], 7, "up"), null)
  assert.deepEqual(trendDelta([{ day: "2026-10-20", value: 5 }, { day: "2026-10-27", value: 5 }], 7, "up"), { change: 0, good: null })
})
