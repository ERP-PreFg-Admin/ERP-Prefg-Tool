// Which readers drop a reverted invoice, and which must keep it. String pins — the risk of a
// soft revert is a query that quietly keeps counting it (docs/invoice-revert-plan.md §4).

import { test } from "node:test"
import assert from "node:assert/strict"
import { supplierInvoicesSql } from "../../lib/queries/supplier-invoices"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { uniwareGrn } from "../../lib/queries/uniware-grn"
import { uniwareDocsSql } from "../../lib/queries/uniware-documents"
import { digestSql } from "../../lib/queries/daily-digest"
import { businessSql } from "../../lib/queries/observability-business"

const flat = (s: string) => s.replace(/\s+/g, " ")

test("readers that must ignore reverted invoices filter them", () => {
  const excluding: Record<string, string> = {
    "supplierInvoicesSql.selectMatchFields (summary strip)": supplierInvoicesSql.selectMatchFields,
    "supplierInvoicesSql.dispatchedBySkuMfg (Dispatch History)": supplierInvoicesSql.dispatchedBySkuMfg,
    "supplierInvoicesSql.selectAllForStatusSync": supplierInvoicesSql.selectAllForStatusSync,
    "supplierInvoicesSql.selectForStatusSyncByFilter": supplierInvoicesSql.selectForStatusSyncByFilter,
    "uniwareGrn.selectForGrnSync": uniwareGrn.selectForGrnSync,
    "uniwareDocsSql.selectSyncCandidates": uniwareDocsSql.selectSyncCandidates,
  }
  for (const [name, sql] of Object.entries(excluding)) {
    assert.match(flat(sql), /reverted_at IS NULL/, `${name} must exclude reverted invoices`)
  }
  assert.match(flat(supplierInvoicesSql.skuHistoryByMfg), /h\.reverted_at IS NULL/, "the SKU matcher must not learn from a reverted invoice")
})

test("the summary strip's reverted count is the complement of its match query", () => {
  assert.match(flat(supplierInvoicesSql.countRevertedInvoices), /reverted_at IS NOT NULL/)
})

test("numbering and history queries must keep reverted rows, or a used number is reissued", () => {
  const keeping: Record<string, string> = {
    "supplierInvoicesSql.maxUniwarePoSerial": supplierInvoicesSql.maxUniwarePoSerial,
    "purchaseOrdersSql.lastSeqByPrefix": purchaseOrdersSql.lastSeqByPrefix,
    "digestSql.invoicesInwarded (counted on its original day)": digestSql.invoicesInwarded,
    "businessSql.invoicesByWeek": businessSql.invoicesByWeek,
  }
  for (const [name, sql] of Object.entries(keeping)) {
    assert.doesNotMatch(flat(sql), /reverted_at|'reverted'/, `${name} must not exclude reverted rows`)
  }
})

test("lists keep reverted invoices and say so", () => {
  const list = flat(supplierInvoicesSql.listInvoices)
  for (const col of ["si.reverted_at", "reverted_by_name", "revert_approved_by_name", "revert_reason", "revert_pending"]) {
    assert.ok(list.includes(col), `listInvoices carries ${col}`)
  }
  assert.doesNotMatch(list, /reverted_at IS NULL/, "the list must not hide reverted invoices")
})

test("a reverted inward PO is terminal, never read back as received or counted as live", () => {
  // Inward POs carry received_qty = qty, so without this the quantity math would call it 'received'.
  assert.match(flat(purchaseOrdersSql.summaryStats), /IN \('cancelled', 'short_closed', 'received', 'reverted'\) THEN po\.status/)
  assert.match(flat(purchaseOrdersSql.summaryStats), /NOT IN \('draft', 'cancelled', 'reverted'\)/)
})

test("a revert's received_qty row is not a receipt for 'last receipt' purposes", () => {
  assert.match(flat(purchaseOrdersSql.lowOpenByMfg), /CAST\(h\.new_value AS DECIMAL\(12,3\)\) > CAST\(h\.old_value AS DECIMAL\(12,3\)\)/)
})
