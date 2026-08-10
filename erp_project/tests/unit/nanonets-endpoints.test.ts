// Nanonets' API paths are OURS to get wrong and THEIRS to define.
//
// On 2026-08-07 our own routes moved to /api/v1/ with a repo-wide find-replace
// on "/api/". It also rewrote these outbound URLs to "/api/v1/v2/files" — which
// compiled, linted, type-checked, and returned 404 from Nanonets on the first
// real invoice upload. Nothing static could see it: it's a string that only
// means anything at the network boundary.
//
// So the shape is pinned here. If a future sweep rewrites them again, this
// fails in `npm test` instead of in someone's parse.
//
// Imports ./endpoints, not ./client — client pulls lib/env in at module load
// and warns about every missing credential. Same reason as
// tests/unit/extraction-strategies.test.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  NANONETS_HOST,
  NANONETS_UPLOAD_PATH,
  NANONETS_EXTRACT_PATH,
} from "../../lib/nanonets/endpoints"

test("the paths carry Nanonets' version, not ours", () => {
  for (const path of [NANONETS_UPLOAD_PATH, NANONETS_EXTRACT_PATH]) {
    assert.ok(
      path.startsWith("/api/v2/"),
      `${path} must start with /api/v2/ — that is Nanonets' API version. ` +
        `If a find-replace on "/api/" touched this, it is now pointing at a URL that 404s.`
    )
    assert.ok(
      !/\/api\/v\d+\/v\d+\//.test(path),
      `${path} has two version segments — our /api/vN prefix leaked into an outbound URL.`
    )
  }
})

test("extraction uses /extract/sync, never /parse/sync", () => {
  // parse only emits markdown/html and ignores the schema, so it succeeds and
  // silently returns prose instead of fields — the worst kind of wrong.
  assert.equal(NANONETS_EXTRACT_PATH, "/api/v2/extract/sync")
  assert.ok(!NANONETS_EXTRACT_PATH.includes("/parse/"))
})

test("upload and extract resolve to absolute nanonets URLs", () => {
  assert.equal(`${NANONETS_HOST}${NANONETS_UPLOAD_PATH}`,
    "https://extraction-api.nanonets.com/api/v2/files")
  assert.equal(`${NANONETS_HOST}${NANONETS_EXTRACT_PATH}`,
    "https://extraction-api.nanonets.com/api/v2/extract/sync")
})
