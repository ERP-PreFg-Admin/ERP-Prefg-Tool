// The platform view is a filter WITHIN the user's grant, driven by a cookie.
// A cookie is user input, so the one property that must hold is: it can narrow
// what you see, and it can NEVER widen it. intersectView is that property,
// extracted from getBrandView precisely so it can be tested without a request
// context (cookies() and the DB are unavailable here).
//
// lib/brand-view.ts imports next/headers, which is importable outside a request
// as long as nothing calls cookies() — these tests only touch the pure function.
import { test } from "node:test"
import assert from "node:assert/strict"
import { intersectView } from "../../lib/brand-view"

test("no grant means unrestricted, so the selection is a plain filter", () => {
  // Matches lib/scope.ts's one rule: absence of rows = unrestricted, never
  // "nothing". An unrestricted user picking two brands just filters.
  assert.equal(intersectView(null, null), null)
  assert.deepEqual(intersectView(null, [1, 2]), [1, 2])
})

test("no selection leaves the grant untouched", () => {
  assert.deepEqual(intersectView([3], null), [3])
  assert.deepEqual(intersectView([1, 3], null), [1, 3])
})

test("a selection inside the grant narrows it", () => {
  assert.deepEqual(intersectView([1, 2, 3], [2]), [2])
  assert.deepEqual(intersectView([1, 2, 3], [1, 3]), [1, 3])
})

test("a selection OUTSIDE the grant cannot widen it", () => {
  // The whole point. A hand-edited cookie naming brands the user doesn't hold
  // must be discarded, not honoured.
  assert.deepEqual(intersectView([3], [1]), [-1], "picking only a non-granted brand sees nothing")
  assert.deepEqual(intersectView([3], [1, 3]), [3], "the non-granted half is dropped")
  assert.deepEqual(intersectView([3], [1, 2]), [-1])
})

test("an empty intersection fails CLOSED, not open", () => {
  // If this returned null or [], the predicate would go inert and the user would
  // see everything — the exact inversion the guard exists to prevent. [-1] matches
  // no master_brand.id, mirroring warehouseNames' [""] guard in lib/scope.ts.
  const out = intersectView([3], [99])
  assert.notEqual(out, null, "must not fall back to unrestricted")
  assert.deepEqual(out, [-1])
})

test("the result is always a subset of the grant", () => {
  // Property check over the interesting shapes rather than one case at a time.
  const grants: (number[] | null)[] = [null, [1], [1, 2], [2, 3, 4]]
  const picks: (number[] | null)[] = [null, [1], [3], [1, 2, 3], [99]]
  for (const grant of grants) {
    for (const picked of picks) {
      const out = intersectView(grant, picked)
      if (grant === null || out === null) continue
      for (const id of out) {
        if (id === -1) continue // the fail-closed sentinel
        assert.ok(grant.includes(id), `${id} escaped grant ${JSON.stringify(grant)}`)
      }
    }
  }
})
