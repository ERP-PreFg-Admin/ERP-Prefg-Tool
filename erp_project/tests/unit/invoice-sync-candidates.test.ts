// The status sweep's candidate rule, asserted on the SQL itself.
//
// The sweep used to take every mirrored invoice, newest first, so a PO closed
// months ago was re-fetched on every press — and because every PO ends up
// COMPLETE, that pile only grows. Measured on prod: 11 of 52 invoices were
// already COMPLETE and carried 11 of the 12 expensive `1+N` receipt walks.
//
// These are string assertions rather than a live query because lib/queries is
// pure (importable without credentials) while the DB is not — tests/unit may
// only import pure modules. What they guard is that the three clauses the rule
// depends on cannot be dropped silently.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  supplierInvoicesSql, TERMINAL_UNIWARE_STATUSES, TERMINAL_RECHECK_DAYS,
} from "../../lib/queries/supplier-invoices"

const ALL      = supplierInvoicesSql.selectAllForStatusSync
const FILTERED = supplierInvoicesSql.selectForStatusSyncByFilter

test("both sweeps skip every terminal Uniware status", () => {
  for (const sql of [ALL, FILTERED]) {
    for (const status of TERMINAL_UNIWARE_STATUSES) {
      assert.match(sql, new RegExp(`NOT IN \\([^)]*'${status}'`))
    }
  }
})

// Without this arm a never-synced invoice — the one that most needs asking
// about — would be excluded by the status test it cannot satisfy.
test("a never-synced invoice always qualifies", () => {
  for (const sql of [ALL, FILTERED]) {
    assert.match(sql, /uniware_status IS NULL/)
  }
})

// The skip must not be permanent: a PO amended after closing has to come back
// round eventually, or it is frozen at whatever it said the day it completed.
test("a terminal invoice is re-admitted once it goes stale", () => {
  for (const sql of [ALL, FILTERED]) {
    assert.match(sql, new RegExp(`uniware_synced_at < NOW\\(\\) - INTERVAL ${TERMINAL_RECHECK_DAYS} DAY`))
    assert.match(sql, /uniware_synced_at IS NULL/)
  }
})

// `id DESC` meant the LIMIT re-took the same newest rows forever, so once the
// mirrored set passed the cap the older ones were never reached again.
test("ordering is least-recently-checked, never-synced first", () => {
  for (const sql of [ALL, FILTERED]) {
    assert.match(sql, /ORDER BY\s+si\.uniware_synced_at IS NOT NULL, si\.uniware_synced_at ASC/)
    assert.doesNotMatch(sql, /ORDER BY\s+si\.id DESC/)
  }
})

test("both sweeps still require a mirrored PO to ask about", () => {
  for (const sql of [ALL, FILTERED]) {
    assert.match(sql, /uniware_po_code IS NOT NULL/)
  }
})

// The filtered variant is what the invoices tab calls. It must carry the list's
// own predicate — that is what makes "sync these" mean the same set as "show
// these", and what applies the caller's entity scope to the sweep.
test("the filtered sweep reuses the list's predicate and joins what it needs", () => {
  assert.match(FILTERED, /INNER JOIN master_mfgs m ON m\.id = si\.mfg_id/)
  assert.match(FILTERED, /si\.mfg_id\s+IN \(\?\)/)      // mfg scope
  assert.match(FILTERED, /si\.destination IN \(\?\)/)   // warehouse scope
  assert.match(FILTERED, /ms\.brand_id IN \(\?\)/)      // brand scope
  assert.match(FILTERED, /si\.invoice_date >= \?/)      // the tab's date filter
})

// Both take a trailing LIMIT, and the route passes MAX_PER_RUN + 1 to detect
// truncation. A sweep that lost its LIMIT would be an unbounded number of
// Uniware round trips inside one request.
test("both sweeps stay bounded by a trailing LIMIT", () => {
  for (const sql of [ALL, FILTERED]) {
    assert.match(sql, /LIMIT \?\s*$/)
  }
})
