// buildInvoiceParams feeds a positional `?` list — the classic way to break it
// is to add a clause to INVOICE_WHERE and forget the matching pair of values (or
// vice versa), which shifts every later param by one and silently filters on the
// wrong column. Both queries that take these params are checked, because the
// list and the count MUST agree or the pager totals rows it can't show.
import { test } from "node:test"
import assert from "node:assert/strict"
import { supplierInvoicesSql, buildInvoiceParams } from "../../lib/queries/supplier-invoices"
import { UNRESTRICTED } from "../../lib/scope"

const count = (sql: string) => (sql.match(/\?/g) ?? []).length

test("param count matches the placeholders in countInvoices", () => {
  const params = buildInvoiceParams("acme", UNRESTRICTED, {
    mfgCode: "MFG01", destination: "Mumbai", dateFrom: "2026-01-01", dateTo: "2026-01-31",
  })
  assert.equal(params.length, count(supplierInvoicesSql.countInvoices))
})

test("listInvoices takes the same params plus limit and offset", () => {
  const params = buildInvoiceParams(null, UNRESTRICTED)
  assert.equal(params.length + 2, count(supplierInvoicesSql.listInvoices))
})

test("an unset filter is NULL, so the `? IS NULL` arm switches it off", () => {
  // Empty strings come off a cleared <select>; they must not match a code of "".
  const params = buildInvoiceParams(null, UNRESTRICTED, { mfgCode: "", dateFrom: "" })
  assert.ok(params.slice(-11).every((p) => p === null))
})

// Uniware's own verdict, and the only filter that surfaces an invoice whose PO
// the warehouse cancelled there — our own record still reads healthy.
test("the uniware status filter contributes three params, all of them the value", () => {
  const params = buildInvoiceParams(null, UNRESTRICTED, { uniwareStatus: "CANCELLED" })
  // The IS NULL guard, the 'none' test, and the equality — all read the same cell.
  assert.deepEqual(params.slice(-3), ["CANCELLED", "CANCELLED", "CANCELLED"])
})

test("a cleared uniware status filter is NULL, not the empty string", () => {
  const params = buildInvoiceParams(null, UNRESTRICTED, { uniwareStatus: "" })
  assert.deepEqual(params.slice(-3), [null, null, null])
})

// 'none' is never-synced. It has to reach the NULL arm rather than compare
// equal to a status literally called "none".
test("'none' selects the never-synced invoices", () => {
  assert.match(supplierInvoicesSql.countInvoices, /'none' AND si\.uniware_status IS NULL/)
})

// Every query taking these params must stay in step, not just the two above.
test("the export and the sync candidate query take the same params", () => {
  const params = buildInvoiceParams(null, UNRESTRICTED)
  assert.equal(params.length, count(supplierInvoicesSql.listInvoicesForExport))
  assert.equal(params.length + 1, count(supplierInvoicesSql.selectForStatusSyncByFilter))
})
