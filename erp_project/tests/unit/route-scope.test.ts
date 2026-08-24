import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

const API_ROOT = join(process.cwd(), "app", "api")

const GUARDED =
  /scope\s*:\s*\{|assertPoInScope|assertInvoiceInScope|assertInScope|assertRecipeInBrandScope|assertSkuIdInBrandScope|assertSkuCodesInBrandScope|assertSkuCodeInBrandScope/

/** A [param] segment, excluding Next's [...catch-all] — not an entity id. */
const ID_SEGMENT = /\[(?!\.\.\.)[^\]]+\]/

/**
 * Routes that are id-addressed but genuinely cannot be scoped. Each needs a
 * reason here — the point is that an exception is a decision someone wrote
 * down, not a call somebody forgot.
 */
const EXEMPT = new Map<string, string>([
  [
    "app/api/v1/approvals/[id]/route.ts",
    "approvals.entity_id is polymorphic — the module decides what it points at, " +
      "and every *_BULK module stores the uploader's user id, not an entity. " +
      "See lib/scope.ts, 'Deliberately NOT scoped yet'.",
  ],
])

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === "route.ts") out.push(full)
  }
  return out
}

const repoPath = (file: string) => relative(process.cwd(), file).split(sep).join("/")

/**
 * One entry per `withGateway({` block.
 *
 * Per block, not per file, for two reasons. A file can export several handlers —
 * `purchase-orders/[id]/route.ts` has PUT and PATCH, both guarded today — and a
 * whole-file search would let a third hide behind the first. And splitting
 * discards everything above the first block, so an `import { assertPoInScope }`
 * line can no longer count as evidence that the guard is actually called.
 */
function gatewayBlocks(src: string): string[] {
  return src.split(/withGateway\s*\(\s*\{/).slice(1)
}

test("every id-addressed route enforces entity scope", () => {
  const unguarded: string[] = []

  for (const file of routeFiles(API_ROOT)) {
    const rel = repoPath(file)
    if (!ID_SEGMENT.test(rel) || EXEMPT.has(rel)) continue

    const blocks = gatewayBlocks(readFileSync(file, "utf8"))
    if (blocks.length === 0) {
      // Takes an id and never reaches the gateway at all, so it has neither
      // `access` nor `scope`. Worse than the case this test was written for.
      unguarded.push(`${rel} (no withGateway block)`)
      continue
    }

    blocks.forEach((block, i) => {
      if (GUARDED.test(block)) return
      unguarded.push(blocks.length > 1 ? `${rel} (handler ${i + 1})` : rel)
    })
  }

  assert.deepEqual(
    unguarded,
    [],
    `These routes take an id from the URL and never check it against the caller's scope. ` +
      `Add \`scope: { type: "…", from: ({ params }) => params.id }\` to withGateway ` +
      `(lib/gateway/scope-rules.ts), or add the route to EXEMPT with a reason:\n  ` +
      unguarded.join("\n  ")
  )
})

test("every EXEMPT route still exists and is still id-addressed", () => {
  // An exemption that outlives its route is a hole waiting for the path to be
  // reused, and one that stops being id-addressed is just noise.
  const present = new Set(routeFiles(API_ROOT).map(repoPath))
  for (const [rel, reason] of EXEMPT) {
    assert.ok(present.has(rel), `EXEMPT lists ${rel}, which no longer exists — drop it`)
    assert.ok(ID_SEGMENT.test(rel), `EXEMPT lists ${rel}, which takes no id — drop it`)
    assert.ok(reason.trim().length > 0, `EXEMPT entry ${rel} needs a reason`)
  }
})

test("the matchers recognise the shapes that actually occur", () => {
  // Guards the guard. Each of these once passed or failed wrongly under a
  // plausible-looking alternative matcher.
  assert.ok(ID_SEGMENT.test("app/api/v1/purchase-orders/[id]/route.ts"))
  assert.ok(ID_SEGMENT.test("app/api/v1/manufacturing/[mfgId]/lines/export/route.ts"))
  assert.ok(!ID_SEGMENT.test("app/api/v1/purchase-orders/route.ts"))
  assert.ok(!ID_SEGMENT.test("app/api/auth/[...nextauth]/route.ts"), "catch-all is not an entity id")

  assert.ok(GUARDED.test('scope: { type: "invoice", from: ({ params }) => params.id }'))
  assert.ok(GUARDED.test("await assertRecipeInBrandScope(userId, id)"), "the InBrandScope family")
  assert.ok(!GUARDED.test("const poId = Number(params.id)"))

  // Two handlers in one file yield two blocks; the import header yields none.
  const src = 'import { assertPoInScope } from "@/lib/po/po-guard"\n' +
    "export const PUT = withGateway({ handler: async () => {} })\n" +
    "export const PATCH = withGateway( {\n handler: async () => {} })\n"
  assert.equal(gatewayBlocks(src).length, 2, "split must tolerate withGateway( { spacing")
  assert.ok(!gatewayBlocks(src).some((b) => GUARDED.test(b)), "an import is not a call")
})
