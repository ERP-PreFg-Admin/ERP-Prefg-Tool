// Guards the PO status filter's 3-slot IN-list. Run: npx tsx scripts/_check-po-status-filter.ts
// FULL_WHERE hardcodes `IN (?, ?, ?)` and every caller (both PO pages + the PO
// export) shares buildFilterParams, so a length or ordering slip here is a
// hard mysql2 error on page load.
import assert from "node:assert/strict"
import { buildFilterParams, statusMatchValues } from "../lib/queries/purchase-orders"

const params = (status: string | null) =>
  buildFilterParams(null, status, null, null, null, null, null, null)

// 6 search + 4 status + 12 filter placeholders
assert.equal(params(null).length, 22)
// [status IS NULL check, then the 3 IN-list slots]
assert.deepEqual(params(null).slice(6, 10), [null, null, null, null])

assert.deepEqual(statusMatchValues("open"), ["raised", "punched", "partially_received"])
assert.deepEqual(params("open").slice(6, 10), ["open", "raised", "punched", "partially_received"])

// Short-closed POs still show under the Received tab.
assert.deepEqual(statusMatchValues("received"), ["received", "short_closed", "short_closed"])

// Any other status matches only itself; the padding is a harmless duplicate.
assert.deepEqual(statusMatchValues("draft"), ["draft", "draft", "draft"])

console.log("PO status filter OK — 22 params, open/received groups intact")
