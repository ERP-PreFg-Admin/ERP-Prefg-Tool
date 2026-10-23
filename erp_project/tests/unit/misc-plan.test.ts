// The misc-cost bulk planner — run at preview, at submit and again at approval, so
// every outcome here is what the uploader sees before anything is staged.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  planMiscRows, describePlanErrors, updatesMissingRemarks, stagedMiscRow, staleSinceUpload,
  type MiscLiveLine,
} from "../../lib/costing/misc-plan"

const skus = [{ id: 1, sku_code: "Mcaf122" }, { id: 2, sku_code: "MCaf48" }, { id: 3, sku_code: "MCaf189" }]
const live: MiscLiveLine[] = [
  { id: 2260, sku_id: 1, type: "jw", status: "active", cost: "7.8000", effective_from: "2025-08-01", effective_till: null },
  { id: 2272, sku_id: 2, type: "jw", status: "in_review", cost: "5.0000", effective_from: "2025-08-01", effective_till: null },
]
const row = (over: Record<string, string>) => ({ sku_code: "MCaf189", type: "jw", cost: "4", effective_from: "2026-10-01", ...over })
const plan1 = (r: Record<string, string>) => planMiscRows([r], skus, live)[0]

test("a SKU with no live line of that type is a new line", () => {
  const p = plan1(row({}))
  assert.equal(p.kind, "new")
  assert.equal(p.kind === "new" && p.sku_id, 3)
})

test("a live line with a different price is an update carrying the live line", () => {
  const p = plan1(row({ sku_code: "mcaf122", cost: "8.25", remarks: "rate revision" }))
  assert.equal(p.kind, "update")
  assert.equal(p.kind === "update" && p.live.id, 2260)
})

test("a date-only change is still an update", () => {
  assert.equal(plan1(row({ sku_code: "Mcaf122", cost: "7.8", effective_from: "2026-10-01" })).kind, "update")
})

// #1425: 24 rows, every one identical to what was already live except the date it would have changed to.
test("a row identical to the live line is refused as nothing to change", () => {
  const p = plan1(row({ sku_code: "Mcaf122", cost: "7.80", effective_from: "2025-08-01" }))
  assert.equal(p.kind, "error")
  assert.match(describePlanErrors([p])[0], /already live at this cost and dates/)
})

test("a slot with a pending change is refused", () => {
  assert.match(describePlanErrors([plan1(row({ sku_code: "MCaf48", cost: "6" }))])[0], /awaiting approval/)
})

test("an unknown SKU, bad type, bad cost and bad date are all reported on the row", () => {
  const msg = describePlanErrors([plan1({ sku_code: "NOPE", type: "freight", cost: "-1", effective_from: "soon" })])
  assert.equal(msg.length, 4)
  assert.match(msg.join(" | "), /no production line/)
  assert.match(msg.join(" | "), /not a misc cost type/)
  assert.match(msg.join(" | "), /non-negative/)
  assert.match(msg.join(" | "), /effective_from/)
})

test("a blank cost is an error, not zero", () => {
  assert.equal(plan1(row({ cost: "" })).kind, "error")
})

test("the same SKU and type twice in one file refuses both rows", () => {
  const plan = planMiscRows([row({}), row({ type: "Job Work", cost: "5" })], skus, live)
  assert.deepEqual(plan.map((p) => p.kind), ["error", "error"])
  assert.match(describePlanErrors(plan)[0], /rows 2, 3/)
})

test("an update needs remarks, a new line does not", () => {
  const plan = planMiscRows([row({}), row({ sku_code: "Mcaf122", cost: "9" })], skus, live)
  assert.equal(updatesMissingRemarks(plan).length, 1)
  assert.match(updatesMissingRemarks(plan)[0], /row 3/)
})

test("the staged row records what it replaces", () => {
  const p = plan1(row({ sku_code: "Mcaf122", cost: "9", remarks: "x" }))
  assert.ok(p.kind === "update")
  const staged = stagedMiscRow(p)
  assert.equal(staged.plan_action, "update")
  assert.equal(staged.old_cost, "7.8")
  assert.equal(staged.old_effective_from, "2025-08-01")
})

test("at approval, a live price that moved since upload is stale", () => {
  const p = plan1(row({ sku_code: "Mcaf122", cost: "9", remarks: "x" }))
  assert.ok(p.kind === "update")
  const staged = stagedMiscRow(p)
  assert.equal(staleSinceUpload(p, staged), null)
  assert.match(String(staleSinceUpload(p, { ...staged, old_cost: "7.5" })), /changed since upload/)
})

test("at approval, a row staged as new that now finds a live line is stale", () => {
  const p = plan1(row({ sku_code: "Mcaf122", cost: "9" }))
  assert.match(String(staleSinceUpload(p, { plan_action: "new" })), /added for it since upload/)
})
