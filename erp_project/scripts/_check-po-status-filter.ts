// Guards the PO status filter's 3-slot IN-list. Run: npx tsx scripts/_check-po-status-filter.ts
// FULL_WHERE hardcodes `IN (?, ?, ?)` and every caller (both PO pages + the PO
// export) shares buildFilterParams, so a length or ordering slip here is a
// hard mysql2 error on page load.
// dotenv only so lib/scope's transitive lib/env import doesn't warn — this
// script touches no DB.
import "dotenv/config"
import assert from "node:assert/strict"
import { buildFilterParams, statusMatchValues, purchaseOrdersSql } from "../lib/queries/purchase-orders"
import { UNRESTRICTED } from "../lib/scope"

const params = (status: string | null) =>
  buildFilterParams(null, status, null, null, null, null, null, null, false, UNRESTRICTED)

// 6 search + 4 status + 14 filter + 1 excludeInward + 6 entity scope (mfg,
// warehouse, brand — 2 each). The filter dozen became fourteen when the
// destination filter gained its entity half: a location is one master_warehouse
// row but two destinations, so the filter matches site AND entity.
assert.equal(params(null).length, 31)

// The invariant this file's header claims to guard but never checked: one bound
// param per placeholder. mysql2 binds positionally, so a predicate added to the
// middle of a WHERE fragment without a matching param inserted at the same
// position shifts every later value silently — until some query errors.
// `IN (?)` is one placeholder taking one array, so a bare `?` count is right.
const sql = purchaseOrdersSql.buildSelectPaginated()
const placeholders = (sql.match(/\?/g) ?? []).length
assert.equal(
  placeholders,
  params(null).length + 2,
  `buildSelectPaginated has ${placeholders} placeholders but buildFilterParams supplies ` +
    `${params(null).length} (+2 for LIMIT/OFFSET). A predicate was added without its param.`
)

// Unrestricted scope must be a no-op pair per dimension: [null, [0]] ×3.
assert.deepEqual(params(null).slice(-6), [null, [0], null, [0], null, [0]])
// [status IS NULL check, then the 3 IN-list slots]
assert.deepEqual(params(null).slice(6, 10), [null, null, null, null])

assert.deepEqual(statusMatchValues("open"), ["raised", "punched", "partially_received"])
assert.deepEqual(params("open").slice(6, 10), ["open", "raised", "punched", "partially_received"])

// Short-closed POs still show under the Received tab.
assert.deepEqual(statusMatchValues("received"), ["received", "short_closed", "short_closed"])

// Any other status matches only itself; the padding is a harmless duplicate.
assert.deepEqual(statusMatchValues("draft"), ["draft", "draft", "draft"])

console.log(
  `PO status filter OK — 31 params matching ${placeholders} placeholders, ` +
    "open/received groups intact, all 3 scope pairs inert"
)
