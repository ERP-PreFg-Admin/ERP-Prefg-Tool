/**
 * The two recipe SHAPES at the API boundary: an ordinary formulation, and a gift
 * kit's list of component SKUs (lib/masters/kit-sku.ts).
 *
 * The interesting part is what each shape switches OFF. A kit has no formulation,
 * so "at least one RM line" and the 99.5-100.5% total cannot apply to it — but
 * they must still apply to everything else, and a caller must not be able to turn
 * them off by claiming to be a kit. The schema decides by the shape of the payload
 * (are there sku_lines?); route.ts decides by the SKU row and 400s `not_a_kit` if
 * the two disagree, which is the half that cannot be tested without a database.
 * These pin the schema half.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { bomCreateFullSchema } from "../../lib/validation/recipe"

const base = {
  action: "create-full" as const,
  mode: "new-version" as const,
  sku_id: 50,
  effective_from: "2026-09-09",
  source: "manual" as const,
}

const parse = (body: Record<string, unknown>) => bomCreateFullSchema.safeParse({ ...base, ...body })
const issuesOn = (r: ReturnType<typeof parse>, path: string) =>
  r.success ? [] : r.error.issues.filter((i) => i.path[0] === path)

// ── The kit shape ─────────────────────────────────────────────────────────────

test("a kit is accepted with components and NO RM at all", () => {
  // The whole point: this payload was impossible before — rm_lines had .min(1)
  // and the total had to reach 100%, so no gift kit could ever have a recipe.
  const r = parse({
    rm_lines: [],
    pm_lines: [],
    sku_lines: [
      { mtrl_type: "sku", mtrl_id: 112, amount: 1, uom: "units" },
      { mtrl_type: "sku", mtrl_id: 327, amount: 2, uom: "units" },
    ],
  })
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues))
})

test("a kit may also carry RM and PM, with no total rule on the RM", () => {
  // "option to add rm to it" — a kit can have its own extras (a filler, a card),
  // and 12% of nothing is not a formulation, so the band must not be applied.
  const r = parse({
    rm_lines: [{ mtrl_type: "rm", mtrl_id: 1, amount: 12 }],
    pm_lines: [{ mtrl_type: "pm", mtrl_id: 9, amount: 1, uom: "pcs" }],
    sku_lines: [{ mtrl_type: "sku", mtrl_id: 112, amount: 1, uom: "units" }],
  })
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues))
})

test("the same component twice is refused", () => {
  // details_recipe's grain is (recipe_id, mtrl_type, mtrl_id), so the second row
  // would overwrite the first's quantity and the kit would silently be short.
  const r = parse({
    rm_lines: [],
    pm_lines: [],
    sku_lines: [
      { mtrl_type: "sku", mtrl_id: 112, amount: 1, uom: "units" },
      { mtrl_type: "sku", mtrl_id: 112, amount: 3, uom: "units" },
    ],
  })
  assert.equal(r.success, false)
  assert.equal(issuesOn(r, "sku_lines").length, 1)
})

test("sku_lines must actually hold 'sku' lines", () => {
  // Guards the array/type agreement the same way rm_lines and pm_lines are
  // guarded — otherwise an rm line smuggled through sku_lines would switch off
  // the RM total AND be inserted as RM.
  const r = parse({
    rm_lines: [],
    pm_lines: [],
    sku_lines: [{ mtrl_type: "rm", mtrl_id: 1, amount: 100 }],
  })
  assert.equal(r.success, false)
  assert.ok(issuesOn(r, "sku_lines").length > 0)
})

// ── The ordinary shape keeps every rule ───────────────────────────────────────

test("without sku_lines, RM is still required and still has to total ~100%", () => {
  assert.equal(parse({ rm_lines: [], pm_lines: [] }).success, false,
    "no RM and no components is not a recipe at all")

  const short = parse({
    rm_lines: [{ mtrl_type: "rm", mtrl_id: 1, amount: 60 }],
    pm_lines: [],
  })
  assert.equal(short.success, false)
  assert.match(issuesOn(short, "rm_lines")[0].message, /99\.5% and 100\.5%/)
})

test("sku_lines defaults to empty, so an existing client's payload is unchanged", () => {
  // Every caller that predates kits omits the field entirely; it must keep
  // getting the full RM treatment rather than being read as a kit.
  const r = parse({
    rm_lines: [{ mtrl_type: "rm", mtrl_id: 1, amount: 100 }],
    pm_lines: [],
  })
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues))
  assert.deepEqual(r.success ? r.data.sku_lines : null, [])
})

test("'sku' is a valid change_type, so a contents-only revision can say why", () => {
  const r = parse({
    rm_lines: [],
    pm_lines: [],
    sku_lines: [{ mtrl_type: "sku", mtrl_id: 112, amount: 1, uom: "units" }],
    reason: "Swapped the 100ml for the 200ml",
    change_type: ["sku"],
  })
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues))
})
