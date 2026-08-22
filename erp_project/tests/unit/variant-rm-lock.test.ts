// resolveRmLock decides whether a recipe may change its RM. Getting it wrong
// either lets RM drift between pack sizes of one product (the whole thing this
// guards against), or locks a base SKU out of the only screen where RM can
// legitimately be changed — leaving a family permanently frozen.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveRmLock, rmLineageHead, rmPropagationTargets, rmDrift, describeRmDrift,
  type FamilyMember,
} from "../../lib/masters/variant-rm-lock"

const member = (
  id: number,
  opts: { base?: boolean; recipe?: number | null; code?: string; at?: string; rmV?: number } = {}
): FamilyMember => ({
  id,
  sku_code: opts.code ?? `SKU-${id}`,
  is_base_sku: opts.base ? 1 : 0,
  active_recipe_id: opts.recipe ?? null,
  bom_code: opts.recipe ? `SKU-${id}-RM1-PM1` : null,
  rm_version: opts.rmV ?? null,
  recipe_created_at: opts.at ?? null,
})

test("a SKU in no family is never locked", () => {
  // base_sku_sno IS NULL selects zero rows; a lone family selects one.
  assert.deepEqual(resolveRmLock(1, []), { locked: false, why: "no_family" })
  assert.deepEqual(resolveRmLock(1, [member(1, { recipe: 9 })]), { locked: false, why: "no_family" })
})

test("a family where nobody has a recipe yet is not locked", () => {
  // Nothing to inherit — the first member to get a recipe seeds the family RM.
  const family = [member(1), member(2), member(3)]
  assert.deepEqual(resolveRmLock(2, family), { locked: false, why: "no_sibling_recipe" })
})

test("the marked base may always change RM", () => {
  const family = [member(1, { base: true }), member(2, { recipe: 20 })]
  assert.deepEqual(resolveRmLock(1, family), { locked: false, why: "is_base" })
})

test("the base stays editable even once every sibling has a recipe", () => {
  // The important one: this is the only route by which a family's RM can ever
  // change. If the sibling-recipe check ran first, the family would freeze.
  const family = [
    member(1, { base: true, recipe: 10 }),
    member(2, { recipe: 20 }),
    member(3, { recipe: 30 }),
  ]
  assert.deepEqual(resolveRmLock(1, family), { locked: false, why: "is_base" })
})

test("a non-base variant inherits RM from the marked base's recipe", () => {
  const family = [
    member(1, { base: true, recipe: 10, code: "FEIN-42-30ML" }),
    member(2, { recipe: 20, code: "FEIN-42-50ML" }),
  ]
  assert.deepEqual(resolveRmLock(2, family), {
    locked: true,
    ownerSkuCode: "FEIN-42-30ML",
    ownerRecipeId: 10,
    ownerBomCode: "SKU-1-RM1-PM1",
    baseDesignated: true,
  })
})

test("with no base marked, RM is inherited from the newest recipe in the family", () => {
  // Ships with is_base_sku = 0 everywhere, so this is the day-one path: RM
  // inheritance has to work before anyone designates a base.
  const family = [
    member(1, { recipe: 10, at: "2026-01-01", code: "A" }),
    member(2, { recipe: 20, at: "2026-06-01", code: "B" }),
    member(3, { code: "C" }),
  ]
  const lock = resolveRmLock(3, family)
  assert.equal(lock.locked, true)
  assert.equal(lock.locked && lock.ownerSkuCode, "B")
  assert.equal(lock.locked && lock.ownerRecipeId, 20)
  // baseDesignated: false is what makes the UI say "designate a base SKU"
  // instead of "edit the base SKU" — there is no base to send anyone to.
  assert.equal(lock.locked && lock.baseDesignated, false)
})

test("a marked base with no recipe of its own still yields to a sibling that has one", () => {
  // Otherwise ownerRecipeId would be null and the lock would carry no RM to
  // inherit. baseDesignated stays true — there IS a base to go edit.
  const family = [member(1, { base: true, code: "BASE" }), member(2, { recipe: 20, code: "SIB" })]
  const lock = resolveRmLock(2, family)
  assert.equal(lock.locked, true)
  assert.equal(lock.locked && lock.ownerSkuCode, "SIB")
  assert.equal(lock.locked && lock.ownerRecipeId, 20)
  assert.equal(lock.locked && lock.baseDesignated, true)
})

test("owner selection is deterministic when timestamps tie or are missing", () => {
  // An arbitrary owner would make the lock flap between requests — the RM grid
  // would seed from a different sibling on each page load.
  const family = [member(1, { recipe: 10 }), member(2, { recipe: 20 }), member(3)]
  const a = resolveRmLock(3, family)
  const b = resolveRmLock(3, [...family].reverse())
  assert.deepEqual(a, b)
  assert.equal(a.locked && a.ownerRecipeId, 20) // higher id = later recipe
})

test("is_base_sku is honoured as a boolean too, not just TINYINT 0/1", () => {
  const family: FamilyMember[] = [
    { id: 1, sku_code: "A", is_base_sku: true, active_recipe_id: 10, bom_code: null },
    { id: 2, sku_code: "B", is_base_sku: false, active_recipe_id: 20, bom_code: null },
  ]
  assert.deepEqual(resolveRmLock(1, family), { locked: false, why: "is_base" })
  assert.equal(resolveRmLock(2, family).locked, true)
})

test("propagation targets are the OTHER members that already have a recipe", () => {
  const family = [
    member(1, { base: true, recipe: 10 }),
    member(2, { recipe: 20 }),
    member(3), // no recipe — nothing to version, inherits on first create
  ]
  assert.deepEqual(rmPropagationTargets(1, family).map((m) => m.id), [2])
  // Never includes the SKU being submitted, or the whole family would be
  // re-versioned twice in one approval.
  assert.deepEqual(rmPropagationTargets(2, family).map((m) => m.id), [1])
})

test("propagation over a family with no other recipes is empty, not a crash", () => {
  assert.deepEqual(rmPropagationTargets(1, [member(1, { base: true, recipe: 10 })]), [])
})

// ── rmLineageHead ───────────────────────────────────────────────────────────
// One definition of "the family's current RM", used both to seed/validate a
// locked variant and to NUMBER it, so the lock and the version can't disagree.

test("the lineage head is the highest RM version, not merely the newest recipe", () => {
  // A sibling created later can still be sitting on an older formulation. Taking
  // the newest would hand the family's RM back to a version already superseded,
  // and the next recipe would renumber to a version that already exists.
  const family = [
    member(1, { recipe: 10, rmV: 3, at: "2026-01-01", code: "MOVED-ON" }),
    member(2, { recipe: 20, rmV: 1, at: "2026-09-01", code: "LEFT-BEHIND" }),
  ]
  assert.equal(rmLineageHead(family)?.sku_code, "MOVED-ON")
})

test("the lineage head falls back to the newest recipe when RM versions tie", () => {
  // The normal case: a family in step all carries the SAME rm_version, so
  // recency is the only thing left to order them by.
  const family = [
    member(1, { recipe: 10, rmV: 2, at: "2026-01-01" }),
    member(2, { recipe: 20, rmV: 2, at: "2026-06-01", code: "NEWEST" }),
  ]
  assert.equal(rmLineageHead(family)?.sku_code, "NEWEST")
})

test("a family with no recipes has no lineage head", () => {
  assert.equal(rmLineageHead([member(1), member(2)]), null)
  assert.equal(rmLineageHead([]), null)
})

// ── rmDrift ─────────────────────────────────────────────────────────────────
// THE INVARIANT: every active recipe in a variant family carries the same
// rm_version. This is the predicate every write path checks, so its edges are
// the edges of the guarantee.

test("a family in step has no drift", () => {
  const family = [
    member(1, { recipe: 10, rmV: 3 }),
    member(2, { recipe: 20, rmV: 3 }),
    member(3, { recipe: 30, rmV: 3 }),
  ]
  assert.deepEqual(rmDrift(family).outliers, [])
  assert.equal(rmDrift(family).headVersion, 3)
  assert.equal(describeRmDrift(family), null)
})

test("a member left behind on an older RM version is drift", () => {
  const family = [
    member(1, { recipe: 10, rmV: 3, code: "IN-STEP" }),
    member(2, { recipe: 20, rmV: 1, code: "LEFT-BEHIND" }),
  ]
  const { headVersion, outliers } = rmDrift(family)
  assert.equal(headVersion, 3)
  assert.deepEqual(outliers.map((m) => m.sku_code), ["LEFT-BEHIND"])
  // The message names both the family's version and who disagrees — an operator
  // has to know which SKU to fix, not just that something is wrong.
  const msg = describeRmDrift(family)!
  assert.match(msg, /RM3/)
  assert.match(msg, /LEFT-BEHIND \(RM1\)/)
})

test("members with NO active recipe are never drift", () => {
  // They have nothing to be out of step with, and inherit the RM when they
  // first get a recipe. Counting them would block every legitimate family.
  const family = [member(1, { recipe: 10, rmV: 2 }), member(2), member(3)]
  assert.deepEqual(rmDrift(family).outliers, [])
  assert.equal(describeRmDrift(family), null)
})

test("a family with one or zero active recipes cannot disagree with itself", () => {
  assert.deepEqual(rmDrift([member(1, { recipe: 10, rmV: 9 })]).outliers, [])
  assert.deepEqual(rmDrift([member(1), member(2)]), { headVersion: null, outliers: [] })
  assert.deepEqual(rmDrift([]), { headVersion: null, outliers: [] })
})

test("every member ahead of the head is reported, not just one", () => {
  // Three-way splits happen when a fan-out half-applied under the old
  // skip-on-failure behaviour. The operator needs the whole list.
  const family = [
    member(1, { recipe: 10, rmV: 5, code: "HEAD" }),
    member(2, { recipe: 20, rmV: 4, code: "A" }),
    member(3, { recipe: 30, rmV: 2, code: "B" }),
  ]
  assert.deepEqual(rmDrift(family).outliers.map((m) => m.sku_code), ["A", "B"])
})

test("a null rm_version counts as 0, not as 'no opinion'", () => {
  // Legacy/backfilled rows can carry NULL. Treating it as absent would let a
  // versionless active recipe sit alongside a versioned one and read as in-step.
  const family = [member(1, { recipe: 10, rmV: 2 }), member(2, { recipe: 20 })]
  assert.deepEqual(rmDrift(family).outliers.map((m) => m.id), [2])
})

test("the lock's RM owner is the lineage head, so validation and numbering agree", () => {
  // If these two ever diverged, a variant would be validated against one
  // recipe's RM and numbered from another's version.
  const family = [
    member(1, { recipe: 10, rmV: 4, at: "2026-01-01", code: "HEAD" }),
    member(2, { recipe: 20, rmV: 2, at: "2026-09-01" }),
    member(3, { code: "NEW" }),
  ]
  const lock = resolveRmLock(3, family)
  assert.equal(lock.locked && lock.ownerSkuCode, "HEAD")
  assert.equal(lock.locked && lock.ownerRecipeId, rmLineageHead(family)?.active_recipe_id)
})
