// The extraction config is what actually reaches Nanonets, and it is assembled
// from three places at once: the base schema, the base rules, and whatever a
// per-manufacturer strategy layers on top. Nothing downstream can tell a badly
// composed config from a well composed one — the call still succeeds, and the
// fields just come back wrong. So the composition is pinned here.
//
// Imports reach into lib/nanonets/* rather than the package index on purpose:
// the index re-exports client.ts, which pulls lib/env in at module load and
// warns about every missing credential. This file has to stay credential-free.
import { test } from "node:test"
import assert from "node:assert/strict"
import { extractionConfig } from "../../lib/nanonets/builder"
import { BASE_INSTRUCTIONS, MAX_INSTRUCTION_CHARS } from "../../lib/nanonets/instructions"
import { STRATEGIES, configFor, strategyFor } from "../../lib/nanonets/strategies"
import type { ExtractionStrategy } from "../../lib/nanonets/strategies/types"

type Described = { description?: string }

/** The line_items field descriptions inside a built config. */
function lineFields(config: ReturnType<typeof configFor>): Record<string, Described> {
  const items = config.json_options.properties.line_items as {
    items: { properties: Record<string, Described> }
  }
  return items.items.properties
}

const noop: ExtractionStrategy = { mfgCode: "MFG-000-TST", label: "Test", configure() {} }

// ── The base ─────────────────────────────────────────────────────────────────

test("no strategy sends exactly the base rules, nothing of the builder's own", () => {
  // The regression that matters: an unrecognised supplier must behave precisely
  // as it did before strategies existed.
  const config = configFor()
  assert.equal(config.custom_instructions, BASE_INSTRUCTIONS.join(" "))
  assert.equal(config.output_format, "json")
  // "append" not "replace" — the schema's own field descriptions carry real
  // instructions, and replace would discard every one of them.
  assert.equal(config.prompt_mode, "append")
})

test("a strategy that does nothing is indistinguishable from no strategy", () => {
  assert.deepEqual(configFor(noop), configFor())
})

test("the do-not-fabricate rule stays last", () => {
  // Every money rule above it defers to this one. A rule appended after it
  // would read as the more specific instruction and quietly win.
  assert.match(BASE_INSTRUCTIONS.at(-1)!, /Do not guess or fabricate values/)
})

// ── Layering ─────────────────────────────────────────────────────────────────

test("a strategy's rules land after the base ones, in order", () => {
  const strategy: ExtractionStrategy = {
    mfgCode: "MFG-000-TST",
    label: "Test",
    configure: (b) => { b.addRules(["FIRST extra rule.", "SECOND extra rule."]) },
  }
  const built = configFor(strategy).custom_instructions
  assert.ok(built.startsWith(BASE_INSTRUCTIONS.join(" ")), "base rules come first")
  assert.ok(built.endsWith("FIRST extra rule. SECOND extra rule."), "extras keep their order")
})

test("a strategy overrides a field description without disturbing its neighbours", () => {
  const strategy: ExtractionStrategy = {
    mfgCode: "MFG-000-TST",
    label: "Test",
    configure: (b) => { b.describeLineField("total_amount", "the rightmost column") },
  }
  const fields = lineFields(configFor(strategy))
  assert.equal(fields.total_amount.description, "the rightmost column")
  assert.equal(fields.rate.description, "Price per unit before tax")
})

// ── Isolation ────────────────────────────────────────────────────────────────

test("a strategy cannot leak into the next call", () => {
  // The builder deep-copies the base schema per call. Without that, one
  // supplier's description would silently apply to every later request in the
  // same process — a bug that only appears under load and never in a test that
  // builds once.
  const baseline = lineFields(configFor()).total_amount.description

  configFor({
    mfgCode: "MFG-000-TST",
    label: "Test",
    configure: (b) => { b.describeLineField("total_amount", "POLLUTED") },
  })

  assert.equal(lineFields(configFor()).total_amount.description, baseline)
  assert.equal(configFor().custom_instructions, BASE_INSTRUCTIONS.join(" "))
})

// ── Guards ───────────────────────────────────────────────────────────────────

test("an unknown field name throws instead of silently doing nothing", () => {
  // A typo'd field would otherwise build fine, call fine, and simply never
  // communicate the quirk — invisible in both the config and the output.
  assert.throws(() => extractionConfig().describeField("invoice_no", "x"), /no header field/)
  assert.throws(() => extractionConfig().describeLineField("qnty", "x"), /no line_items field/)
})

test("the thrown message names the fields that do exist", () => {
  // The whole value of failing here is telling the author what to write instead.
  assert.throws(() => extractionConfig().describeField("nope", "x"), /invoice_number/)
})

test("line_items is redirected to describeLineField", () => {
  // Describing the array itself is almost always a mistake for its contents.
  assert.throws(() => extractionConfig().describeField("line_items", "x"), /describeLineField/)
})

test("instructions past the documented cap throw at build time", () => {
  // Nanonets caps custom_instructions at 8000 chars. Silently truncating there
  // would drop whichever rules happened to sort last.
  const builder = extractionConfig().addRules(["x".repeat(MAX_INSTRUCTION_CHARS)])
  assert.throws(() => builder.build(), /over the 8000 limit/)
})

test("the base leaves room for strategies to add to it", () => {
  assert.ok(
    configFor().custom_instructions.length < MAX_INSTRUCTION_CHARS / 2,
    "base rules should not consume half the budget on their own"
  )
})

// ── The registry ─────────────────────────────────────────────────────────────

test("strategyFor returns the first GSTIN that has a registration", () => {
  // Mutating the real registry rather than injecting one: strategyFor reads
  // STRATEGIES directly, and a seam existing only for this test would be a
  // worse trade than restoring the keys in a finally.
  const A = "27AAKFR0481L1ZT"
  const B = "18AAICP2804J1ZB"
  const first: ExtractionStrategy = { mfgCode: "MFG-001-AAA", label: "A", configure() {} }
  const second: ExtractionStrategy = { mfgCode: "MFG-002-BBB", label: "B", configure() {} }

  try {
    STRATEGIES[A] = first
    STRATEGIES[B] = second
    // Document order decides, not registration order.
    assert.equal(strategyFor([B, A]), second)
    assert.equal(strategyFor([A, B]), first)
    // An unregistered GSTIN earlier in the list is skipped, not fatal.
    assert.equal(strategyFor(["99ZZZZZ9999Z9ZZ", A]), first)
  } finally {
    delete STRATEGIES[A]
    delete STRATEGIES[B]
  }
})

test("an unrecognised supplier gets no strategy rather than a wrong one", () => {
  assert.equal(strategyFor([]), undefined)
  assert.equal(strategyFor(["99ZZZZZ9999Z9ZZ"]), undefined)
})

test("the registry ships empty", () => {
  // Deliberate: an entry is earned when a real sample proves the base rules
  // fail on that supplier's format. Delete this test when the first one lands.
  assert.equal(Object.keys(STRATEGIES).length, 0)
})
