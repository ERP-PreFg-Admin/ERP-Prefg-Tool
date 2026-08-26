// The RM-sums-to-100 band, which nine call sites read (three server, six
// client) and which nothing pinned until now — the band could be moved, or a
// message left quoting the old numbers, and CI stayed green.
//
// The message assertion is the point of this file as much as the band is: the
// wording used to be typed out by hand at four call sites, all naming
// "99.9% and 100.1%", so widening the band meant four places lying about it.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isRmTotalValid,
  rmTotalMessage,
  RM_TOTAL_MIN,
  RM_TOTAL_MAX,
  bomCreateFullSchema,
} from "../../lib/validation/recipe"

test("the band is 99.5-100.5, inclusive at both ends", () => {
  assert.equal(RM_TOTAL_MIN, 99.5)
  assert.equal(RM_TOTAL_MAX, 100.5)

  assert.equal(isRmTotalValid(100), true)
  assert.equal(isRmTotalValid(99.5), true, "the lower bound is allowed, not just approached")
  assert.equal(isRmTotalValid(100.5), true, "the upper bound is allowed")
  assert.equal(isRmTotalValid(99.6), true)
  assert.equal(isRmTotalValid(100.4), true)

  assert.equal(isRmTotalValid(99.49), false)
  assert.equal(isRmTotalValid(100.51), false)
  assert.equal(isRmTotalValid(0), false)
  assert.equal(isRmTotalValid(200), false)
})

test("the message quotes the live constants, never a hardcoded band", () => {
  const msg = rmTotalMessage(99.4)
  assert.ok(msg.includes(String(RM_TOTAL_MIN)), "names the current lower bound")
  assert.ok(msg.includes(String(RM_TOTAL_MAX)), "names the current upper bound")
  assert.ok(msg.includes("99.40"), "tells the user what their total actually is")
  // The exact numbers, so a future edit that reintroduces a literal fails here.
  assert.match(msg, /between 99\.5% and 100\.5%/)
})

test("create-full accepts a recipe inside the widened band", () => {
  // 99.6 was rejected before this change and is the case users hit.
  const parsed = bomCreateFullSchema.safeParse({
    action: "create-full",
    mode: "new-version",
    sku_id: 1,
    effective_from: "2026-01-01",
    source: "manual",
    rm_lines: [
      { mtrl_type: "rm", mtrl_id: 1, amount: 60 },
      { mtrl_type: "rm", mtrl_id: 2, amount: 39.6 },
    ],
    pm_lines: [],
  })
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues))
})

test("create-full still refuses a total outside the band", () => {
  const parsed = bomCreateFullSchema.safeParse({
    action: "create-full",
    mode: "new-version",
    sku_id: 1,
    effective_from: "2026-01-01",
    source: "manual",
    rm_lines: [
      { mtrl_type: "rm", mtrl_id: 1, amount: 60 },
      { mtrl_type: "rm", mtrl_id: 2, amount: 39.4 },
    ],
    pm_lines: [],
  })
  assert.equal(parsed.success, false)
  const issue = parsed.success ? null : parsed.error.issues.find((i) => i.path[0] === "rm_lines")
  assert.ok(issue, "the issue is reported against rm_lines, which is what the UI reads")
  assert.match(issue!.message, /99\.5% and 100\.5%/)
})

test("PM lines carry no total rule — they are counts, not percentages", () => {
  // A bottle is one bottle. PM is also SKU-scoped where RM is family-scoped
  // (lib/masters/variant-rm-lock.ts), so a variant may freely differ on PM.
  const parsed = bomCreateFullSchema.safeParse({
    action: "create-full",
    mode: "new-version",
    sku_id: 1,
    effective_from: "2026-01-01",
    source: "manual",
    rm_lines: [{ mtrl_type: "rm", mtrl_id: 1, amount: 100 }],
    pm_lines: [
      { mtrl_type: "pm", mtrl_id: 9, amount: 1, uom: "pcs" },
      { mtrl_type: "pm", mtrl_id: 10, amount: 1, uom: "pcs" },
    ],
  })
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues))
})
