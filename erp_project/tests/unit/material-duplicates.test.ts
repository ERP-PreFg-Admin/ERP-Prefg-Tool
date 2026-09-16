// The normalised-name key behind the CSV-preview duplicate warning.
//
// Every case below is a real pair from mcaff_prefg_prod — the collisions an
// exact-name lookup was missing, and the look-alikes it must keep apart.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeName, findNameCollision, sameNameMakes, collisionMessage,
  type MaterialRow,
} from "../../lib/masters/material-duplicates"

const rm = (id: number, code: string, name: string, make?: string): MaterialRow =>
  ({ id, code, name, make })

test("case and spacing differences collapse to one key", () => {
  assert.equal(normalizeName("TWEEN 80"), normalizeName("Tween 80"))
  assert.equal(normalizeName("Gmoist BT 99"), normalizeName("Gmoist BT99"))
  assert.equal(normalizeName("Color-B.blue + T.yellow"), normalizeName("Color -B.blue + T.yellow"))
})

// The reason this uses NFD and not NFKD: NFKD expands ™ to the letters
// "TM", which would key FOAMYSENSE™ as `foamysensetm` and stop it matching
// the plain-text row it actually duplicates.
test("a trademark sign does not change the key", () => {
  assert.equal(normalizeName("FOAMYSENSE™ N60K Polymer"), "foamysensen60kpolymer")
  assert.equal(
    normalizeName("FOAMYSENSE™ N60K Polymer"),
    normalizeName("FOAMYSENSE N60K Polymer"),
  )
  assert.equal(normalizeName("Carbopol® Aqua SF-1"), normalizeName("Carbopol Aqua SF 1"))
})

// A mojibake row must key the same as its repaired form, or repairing
// master_rm would create a "new" material as far as this check is concerned.
test("a U+FFFD keys the same as the character it destroyed", () => {
  assert.equal(normalizeName("Carbopol� Aqua"), normalizeName("Carbopol® Aqua"))
})

test("an accent is folded, not dropped with the letter", () => {
  assert.equal(normalizeName("Crème Base"), "cremebase")
})

test("digits are significant — different grades stay different", () => {
  assert.notEqual(normalizeName("Tween 80"), normalizeName("Tween 20"))
  assert.notEqual(normalizeName("Gmoist BT99"), normalizeName("Gmoist BT98"))
})

test("a name with no letters or digits has no key, and never collides", () => {
  assert.equal(normalizeName("---"), "")
  assert.equal(findNameCollision([rm(1, "RM-1", "---")], "###"), null)
})

test("same name under a different make is not a duplicate", () => {
  // Prod holds both, legitimately — two suppliers for one commodity.
  const existing = [rm(23, "RM-DISO-SIDD-0023", "Disodium EDTA", "Siddharth")]
  assert.equal(findNameCollision(existing, "Disodium EDTA", "Kusum"), null)
})

test("same name and same make is a duplicate, however it is spelled", () => {
  const existing = [rm(169, "RM-FOAM-DOW-0169", "FOAMYSENSE N60K Polymer", "Dow")]
  const hit = findNameCollision(existing, "FOAMYSENSE™ N60K Polymer", "DOW")
  assert.equal(hit?.id, 169)
})

test("PM has no make, so the name alone is the key", () => {
  const existing = [rm(347, "PM-0347", "Mono Carton EDP (Fein) Cherry wine 50ml")]
  assert.equal(findNameCollision(existing, "Mono carton EDP (Fein) cherry wine 50ml")?.id, 347)
})

test("sameNameMakes ignores spacing, and excludes the candidate's own make", () => {
  const existing = [
    rm(202, "RM-GMOI-CHIN-0202", "Gmoist BT 99", "Chinmay"),
    rm(1011, "RM-GMOI-JAKA-1011", "Gmoist BT99", "Jakaria"),
    rm(1, "RM-OTHER", "Something Else", "Adani"),
  ]
  // The old exact-name SQL returned nothing here; both spellings are one name.
  assert.deepEqual(sameNameMakes(existing, "Gmoist BT-99", "Jakaria"), ["Chinmay"])
})

test("the warning names the existing record, and its make when there is one", () => {
  const msg = collisionMessage(rm(169, "RM-FOAM-DOW-0169", "FOAMYSENSE N60K Polymer", "Dow"), "FOAMYSENSE™ N60K Polymer")
  assert.match(msg, /RM-FOAM-DOW-0169/)
  assert.match(msg, /Dow/)
})
