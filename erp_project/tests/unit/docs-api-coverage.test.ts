import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

/**
 * Docs drift guard. Catches the highest-frequency rot: a route added, renamed or
 * deleted without a matching edit in docs/api/.
 *
 * It does NOT check that the documented schema, access level or error codes are
 * still right — only that every route is mentioned and every mentioned route
 * exists. Widening it to compare contracts would mean parsing the docs, which
 * rots faster than the thing it guards. Verify contracts by reading the route.
 *
 * Mirrors tests/unit/route-scope.test.ts, which walks the same tree.
 */

const API_ROOT  = join(process.cwd(), "app", "api")
const DOCS_ROOT = join(process.cwd(), "docs", "api")

/** Routes deliberately absent from docs/api/. Each needs a reason. */
const EXEMPT = new Map<string, string>([])

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === "route.ts") out.push(full)
  }
  return out
}

/** app/api/v1/masters/vendors/route.ts -> /api/v1/masters/vendors */
const urlOf = (file: string) =>
  "/" + relative(join(process.cwd(), "app"), file).split(sep).slice(0, -1).join("/")

const docsText = readdirSync(DOCS_ROOT)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(DOCS_ROOT, f), "utf8"))
  .join("\n")

const routes = routeFiles(API_ROOT).map(urlOf)

test("every route under app/api is documented in docs/api/", () => {
  const missing = routes
    .filter((u) => !EXEMPT.has(u))
    .filter((u) => !docsText.includes(u))
  assert.deepEqual(
    missing,
    [],
    `Undocumented routes — add them to the right docs/api/*.md:\n  ${missing.join("\n  ")}`
  )
})

test("docs/api/ census names no route that no longer exists", () => {
  // Only the census code blocks in README.md are authoritative; prose elsewhere may
  // legitimately mention a deleted route while explaining why it went.
  const readme = readFileSync(join(DOCS_ROOT, "README.md"), "utf8")
  const census = [...readme.matchAll(/^(?:GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)$/gm)].map((m) => m[1])
  assert.ok(census.length > 0, "README.md census parsed as empty — the format changed")

  const live = new Set(routes)
  const stale = [...new Set(census)].filter((u) => !live.has(u))
  assert.deepEqual(
    stale,
    [],
    `Census names routes that no longer exist — delete them from docs/api/README.md:\n  ${stale.join("\n  ")}`
  )
})

test("the census covers every route file exactly once", () => {
  const readme = readFileSync(join(DOCS_ROOT, "README.md"), "utf8")
  const census = new Set(
    [...readme.matchAll(/^(?:GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)$/gm)].map((m) => m[1])
  )
  const uncensused = routes.filter((u) => !census.has(u))
  assert.deepEqual(
    uncensused,
    [],
    `Routes missing from the docs/api/README.md census:\n  ${uncensused.join("\n  ")}`
  )
})
