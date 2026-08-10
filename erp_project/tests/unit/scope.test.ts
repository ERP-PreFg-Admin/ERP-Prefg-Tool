// Per-user entity scoping. The load-bearing property is that an UNRESTRICTED
// scope is a perfect no-op: if that ever breaks, every existing user silently
// loses access to data they could see yesterday. These are the pure helpers;
// scripts/_check-entity-scope.ts proves the same property against real SQL.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  UNRESTRICTED, scopeClause, scopeParams, inScope, filterByScope, assertInScope,
  type UserScope,
} from "../../lib/scope"

test("scopeParams(null) short-circuits the predicate", () => {
  // [null, [0]] — the null makes `? IS NULL` true so the IN never applies, and
  // the dummy [0] exists only because `IN ()` is a MySQL syntax error.
  assert.deepEqual(scopeParams(null), [null, [0]])
})

test("scopeParams([]) is treated as unrestricted, not as 'nothing'", () => {
  // An empty allow-list must never compile to "sees no rows" — that would lock a
  // user out of every screen with no way for them to say so.
  assert.deepEqual(scopeParams([]), [null, [0]])
})

test("scopeParams with ids activates the predicate and passes the list intact", () => {
  assert.deepEqual(scopeParams([3, 7]), [1, [3, 7]])
  assert.deepEqual(scopeParams(["Guwahati"]), [1, ["Guwahati"]])
})

test("scopeParams always returns exactly two params, in flag-then-list order", () => {
  // The flag MUST be separate from the list: an array in the flag slot expands to
  // `(1,2,3) IS NULL` and fails to parse. Callers spread this into a param array,
  // so arity is part of the contract.
  for (const ids of [null, [], [1], [1, 2, 3]] as (number[] | null)[]) {
    const p = scopeParams(ids)
    assert.equal(p.length, 2, `arity for ${JSON.stringify(ids)}`)
    assert.ok(p[0] === null || p[0] === 1)
    assert.ok(Array.isArray(p[1]))
  }
})

test("scopeClause emits a leading AND and one placeholder per param", () => {
  const sql = scopeClause("po.mfg_id")
  assert.match(sql, /^\s*AND\b/, "must append to an existing WHERE")
  assert.match(sql, /po\.mfg_id IN \(\?\)/)
  assert.equal((sql.match(/\?/g) ?? []).length, 2, "one ? for the flag, one for the list")
})

test("UNRESTRICTED is null on every dimension", () => {
  // null means unrestricted; an empty array would mean "nothing" and is never used.
  assert.deepEqual(UNRESTRICTED, { mfgIds: null, vendorIds: null, warehouseNames: null })
})

test("inScope passes everything when the dimension is unrestricted", () => {
  assert.equal(inScope(UNRESTRICTED, "mfg", 1), true)
  assert.equal(inScope(UNRESTRICTED, "mfg", 99999), true)
  assert.equal(inScope(UNRESTRICTED, "vendor", 42), true)
  assert.equal(inScope(UNRESTRICTED, "warehouse", "Anywhere"), true)
})

test("inScope enforces the allow-list when restricted", () => {
  const scope: UserScope = { mfgIds: [3, 7], vendorIds: [11], warehouseNames: ["Guwahati"] }
  assert.equal(inScope(scope, "mfg", 3), true)
  assert.equal(inScope(scope, "mfg", 4), false)
  assert.equal(inScope(scope, "vendor", 11), true)
  assert.equal(inScope(scope, "vendor", 3), false, "mfg ids must not leak into the vendor dimension")
  assert.equal(inScope(scope, "warehouse", "Guwahati"), true)
  assert.equal(inScope(scope, "warehouse", "Bhiwandi"), false)
})

test("inScope coerces string ids, because they arrive from URLs", () => {
  const scope: UserScope = { mfgIds: [3], vendorIds: null, warehouseNames: null }
  assert.equal(inScope(scope, "mfg", "3"), true)
  assert.equal(inScope(scope, "mfg", "4"), false)
})

test("inScope passes a null id — absent is not out-of-scope", () => {
  // Plenty of older POs have no destination; those can't be out of a warehouse scope.
  const scope: UserScope = { mfgIds: [3], vendorIds: null, warehouseNames: ["Guwahati"] }
  assert.equal(inScope(scope, "warehouse", null), true)
  assert.equal(inScope(scope, "mfg", undefined), true)
})

test("assertInScope throws 403 out_of_scope, and stays silent when allowed", () => {
  const scope: UserScope = { mfgIds: [3], vendorIds: null, warehouseNames: null }
  assert.doesNotThrow(() => assertInScope(scope, "mfg", 3))
  assert.doesNotThrow(() => assertInScope(UNRESTRICTED, "mfg", 12345))

  assert.throws(
    () => assertInScope(scope, "mfg", 4),
    (err: unknown) => {
      const e = err as { status?: number; code?: string; message?: string }
      assert.equal(e.status, 403, "must be a hard 403, not an empty result")
      assert.equal(e.code, "out_of_scope")
      assert.match(String(e.message), /manufacturer/, "the message names the entity type")
      return true
    }
  )
})

test("filterByScope is the identity function when unrestricted", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const out = filterByScope(rows, "id", null)
  assert.deepEqual(out, rows)
  assert.equal(out.length, 3)
})

test("filterByScope keeps only allowed rows, comparing as strings", () => {
  const rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }]
  assert.deepEqual(filterByScope(rows, "id", [1, 3]).map(r => r.name), ["a", "c"])
  // Mixed types must still match — ids come back from MySQL as numbers but arrive
  // from URLs as strings.
  assert.deepEqual(filterByScope(rows, "id", ["2"]).map(r => r.name), ["b"])
})

test("filterByScope on an empty allow-list returns nothing", () => {
  // Distinct from scopeParams: by the time a caller has [] here it has already
  // decided the dimension is restricted, so [] genuinely means no rows.
  assert.deepEqual(filterByScope([{ id: 1 }], "id", []), [])
})
