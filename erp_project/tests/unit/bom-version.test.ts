// diffBomLines decides which side of a BOM code version-bumps. Getting it wrong
// either invents versions nobody asked for, or reuses a version number for a
// genuinely different recipe — and the bom_code is what production quotes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { diffBomLines, type DiffableLine } from "../../lib/masters/recipe-version"

const rm = (id: number, amount: number | string, uom = "kg"): DiffableLine =>
  ({ mtrl_type: "rm", mtrl_id: id, amount, uom })
const pm = (id: number, amount: number | string, uom = "pc"): DiffableLine =>
  ({ mtrl_type: "pm", mtrl_id: id, amount, uom })

const BASE: DiffableLine[] = [rm(1, 30), rm(2, 70), pm(10, 1), pm(11, 2)]

test("an identical line set is no change on either side", () => {
  assert.deepEqual(diffBomLines(BASE, [...BASE]), { rmChanged: false, pmChanged: false })
})

test("line ORDER does not count as a change", () => {
  // Compared as sets. If this regressed to an index-wise comparison, simply
  // reordering the editor's rows would bump both versions.
  const shuffled = [pm(11, 2), rm(2, 70), pm(10, 1), rm(1, 30)]
  assert.deepEqual(diffBomLines(BASE, shuffled), { rmChanged: false, pmChanged: false })
})

test("an RM amount change bumps ONLY the RM side", () => {
  const next = [rm(1, 35), rm(2, 65), pm(10, 1), pm(11, 2)]
  assert.deepEqual(diffBomLines(BASE, next), { rmChanged: true, pmChanged: false })
})

test("a PM amount change bumps ONLY the PM side", () => {
  const next = [rm(1, 30), rm(2, 70), pm(10, 3), pm(11, 2)]
  assert.deepEqual(diffBomLines(BASE, next), { rmChanged: false, pmChanged: true })
})

test("changing both sides bumps both", () => {
  const next = [rm(1, 31), rm(2, 69), pm(10, 5), pm(11, 2)]
  assert.deepEqual(diffBomLines(BASE, next), { rmChanged: true, pmChanged: true })
})

test("adding a line counts as a change on that side", () => {
  assert.deepEqual(diffBomLines(BASE, [...BASE, rm(3, 5)]), { rmChanged: true, pmChanged: false })
  assert.deepEqual(diffBomLines(BASE, [...BASE, pm(12, 1)]), { rmChanged: false, pmChanged: true })
})

test("removing a line counts as a change on that side", () => {
  assert.deepEqual(
    diffBomLines(BASE, [rm(1, 30), pm(10, 1), pm(11, 2)]),
    { rmChanged: true, pmChanged: false }
  )
  assert.deepEqual(
    diffBomLines(BASE, [rm(1, 30), rm(2, 70), pm(10, 1)]),
    { rmChanged: false, pmChanged: true }
  )
})

test("swapping one material for another is a change even at the same amount", () => {
  const next = [rm(1, 30), rm(9, 70), pm(10, 1), pm(11, 2)]
  assert.deepEqual(diffBomLines(BASE, next), { rmChanged: true, pmChanged: false })
})

test("a uom change is a change, even at the same numeric amount", () => {
  // 30 g and 30 kg are not the same line.
  const next = [rm(1, 30, "g"), rm(2, 70), pm(10, 1), pm(11, 2)]
  assert.deepEqual(diffBomLines(BASE, next), { rmChanged: true, pmChanged: false })
})

test("rm and pm ids are independent sequences and must not cross-match", () => {
  // rm 1 and pm 1 are different materials that happen to share an id.
  const before = [rm(1, 10)]
  const after = [pm(1, 10)]
  assert.deepEqual(diffBomLines(before, after), { rmChanged: true, pmChanged: true })
})

test("amount is normalized numerically, so DECIMAL strings don't fake a change", () => {
  // This is the important one. MySQL returns DECIMAL(12,4) as "40.0000" while the
  // client submits 40. Without Number() normalization EVERY line would read as
  // changed and both versions would bump on every save.
  const same = { rmChanged: false, pmChanged: false }
  assert.deepEqual(diffBomLines([rm(1, 30)], [rm(1, "30")]), same)
  assert.deepEqual(diffBomLines([rm(1, 30)], [rm(1, "30.0")]), same)
  assert.deepEqual(diffBomLines([rm(1, 30)], [rm(1, "30.0000")]), same)
  assert.deepEqual(diffBomLines([rm(1, 0.5)], [rm(1, ".5000")]), same)

  // A genuinely different number still registers.
  assert.deepEqual(diffBomLines([rm(1, 30)], [rm(1, "30.0001")]), { rmChanged: true, pmChanged: false })
})

test("uom comparison ignores case and surrounding whitespace", () => {
  const same = { rmChanged: false, pmChanged: false }
  assert.deepEqual(diffBomLines([rm(1, 30, "kg")], [rm(1, 30, "KG")]), same)
  assert.deepEqual(diffBomLines([rm(1, 30, "kg")], [rm(1, 30, " kg ")]), same)
  // A missing uom and an empty one are the same absence.
  assert.deepEqual(
    diffBomLines([{ mtrl_type: "rm", mtrl_id: 1, amount: 30 }], [rm(1, 30, "")]),
    same
  )
})

test("a non-numeric amount falls back to the raw value rather than becoming NaN", () => {
  // If both sides were coerced to NaN they'd compare equal and a real edit would
  // be missed. The fallback keeps junk values distinguishable.
  assert.deepEqual(
    diffBomLines([rm(1, "abc")], [rm(1, "def")]),
    { rmChanged: true, pmChanged: false }
  )
  assert.deepEqual(
    diffBomLines([rm(1, "abc")], [rm(1, "abc")]),
    { rmChanged: false, pmChanged: false }
  )
})

test("an empty prior BOM against any lines is a change on the populated sides", () => {
  assert.deepEqual(diffBomLines([], [rm(1, 30)]), { rmChanged: true, pmChanged: false })
  assert.deepEqual(diffBomLines([], []), { rmChanged: false, pmChanged: false })
})
