// Nanonets' own API paths, kept apart from client.ts so a test can import them
// without pulling lib/env (and its missing-credential warnings) in — the same
// reason tests/unit/extraction-strategies.test.ts reaches for builder.ts rather
// than the package index.
//
// These are `/api/v2/` because that is NANONETS' version, and it has nothing to
// do with ours. Our own routes moved to /api/v1/ on 2026-08-07 by a repo-wide
// find-replace on "/api/", which rewrote these to "/api/v1/v2/" — a URL that
// compiles, lints, type-checks, and 404s on the first real upload. Nothing but
// a live invoice parse caught it.
//
// tests/unit/nanonets-endpoints.test.ts pins the shape so the next one trips a
// test instead of a support ticket.

/** Host these are joined to. Exported for the test's assertion only. */
export const NANONETS_HOST = "https://extraction-api.nanonets.com"

/** multipart → { file_id: "file://<uuid>" } */
export const NANONETS_UPLOAD_PATH = "/api/v2/files"

/**
 * json → { result: { content: <our schema> } }
 *
 * Must be /extract/sync, NOT /parse/sync: parse only emits markdown/html and
 * ignores the schema entirely, so it silently returns prose instead of fields.
 */
export const NANONETS_EXTRACT_PATH = "/api/v2/extract/sync"
