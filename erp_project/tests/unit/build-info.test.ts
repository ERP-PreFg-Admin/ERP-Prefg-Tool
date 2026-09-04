import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAge } from "../../lib/build-info"

const NOW = new Date("2026-09-02T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

test("a fresh build reads as just now", () => {
  assert.equal(buildAge(ago(5_000), NOW), "just now")
})

test("minutes, hours and days each get their own unit", () => {
  assert.equal(buildAge(ago(12 * 60_000), NOW), "12m ago")
  assert.equal(buildAge(ago(5 * 3_600_000), NOW), "5h ago")
  assert.equal(buildAge(ago(3 * 86_400_000), NOW), "3d ago")
})

test("each boundary rolls over to the next unit rather than saying 60", () => {
  assert.equal(buildAge(ago(60_000), NOW), "1m ago")
  assert.equal(buildAge(ago(3_600_000), NOW), "1h ago")
  assert.equal(buildAge(ago(86_400_000), NOW), "1d ago")
})

test("a stale build is loud — this is the whole point of the field", () => {
  // The failure being guarded against: a deploy did not land, the box is still
  // running last week's container, and the SHA on screen means nothing to anyone.
  assert.equal(buildAge(ago(9 * 86_400_000), NOW), "9d ago")
})

test("a missing or unparseable stamp renders nothing, never 'NaN ago'", () => {
  assert.equal(buildAge(null, NOW), null)
  assert.equal(buildAge(undefined, NOW), null)
  assert.equal(buildAge("", NOW), null)
  assert.equal(buildAge("unknown", NOW), null)
})

test("clock skew does not produce a negative age", () => {
  // The CI runner stamps BUILD_TIME; a viewer's clock can sit behind it.
  assert.equal(buildAge(new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), NOW), null)
})
