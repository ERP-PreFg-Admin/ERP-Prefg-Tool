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
  assert.ok(params.slice(-8).every((p) => p === null))
})
