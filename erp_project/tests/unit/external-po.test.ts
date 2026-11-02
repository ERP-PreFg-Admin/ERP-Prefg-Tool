// Uniware-only POs: what the sweep keeps from a detail call, and which ones Add Invoice may adopt.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyExternalPo, invoiceNoFromReference, mapPoDetail, sameInvoiceNo, skusMissingFromPo,
} from "../../lib/uniware/external-po"

test("the invoice number is the ReferenceNo up to its first space", () => {
  assert.equal(invoiceNoFromReference("MBA2627/GIS00085 EXCESS PO"), "MBA2627/GIS00085")
  assert.equal(invoiceNoFromReference("  RP/L/26-27/1401 "), "RP/L/26-27/1401")
  assert.equal(invoiceNoFromReference(""), null)
  assert.equal(invoiceNoFromReference(null), null)
})

test("invoice numbers compare without case or spaces, and blank never matches", () => {
  assert.ok(sameInvoiceNo("mba2627/gis00460", "MBA2627/GIS00460"))
  assert.ok(sameInvoiceNo("KCPL/C2627/ 1218", "KCPL/C2627/1218"))
  assert.ok(!sameInvoiceNo("", ""))
  assert.ok(!sameInvoiceNo(null, "X"))
})

// Shape taken from GM/2627/PO/2731 on prod, 2026-11-02: `created` is epoch millis, ReferenceNo a custom field.
test("mapPoDetail keeps the fields the cache stores", () => {
  const m = mapPoDetail(
    {
      vendorCode: "NG_ELECTRO", statusCode: "COMPLETE", inflowReceiptsCount: 1,
      createdBy: "yogesh@example.com", created: 1790834739000,
      customFieldValues: [
        { fieldName: "ReferenceNo", fieldValue: "MBA2627/GIS00501" },
        { fieldName: "ReferenceOrder", fieldValue: null },
      ],
    },
    [
      { itemSKU: "PMRAW133", quantity: 2000, unitPrice: 6.81, maxRetailPrice: 0.01 },
      { itemSKU: "", quantity: 5 },
    ],
  )
  assert.equal(m.reference_no, "MBA2627/GIS00501")
  assert.equal(m.un_status, "COMPLETE")
  assert.equal(m.grn_count, 1)
  assert.equal(m.un_created_at?.toISOString(), new Date(1790834739000).toISOString())
  assert.deepEqual(m.items, [{ sku_code: "PMRAW133", qty: 2000, unit_price: 6.81, mrp: 0.01 }])
})

test("a PO with no ReferenceNo stores null, not an empty string", () => {
  assert.equal(mapPoDetail({ customFieldValues: [{ fieldName: "ReferenceNo", fieldValue: " " }] }, []).reference_no, null)
  assert.equal(mapPoDetail({}, []).un_created_at, null)
})

test("only a live, all-FG PO whose invoice is not in the ERP is adoptable", () => {
  const base = { un_status: "COMPLETE", all_fg: true, adopted: false, live_invoice_no: null }
  assert.equal(classifyExternalPo(base), "missing")
  assert.equal(classifyExternalPo({ ...base, live_invoice_no: "KCPL/C2627/1218" }), "replacement")
  assert.equal(classifyExternalPo({ ...base, all_fg: false }), "not_fg")
  assert.equal(classifyExternalPo({ ...base, un_status: "cancelled" }), "cancelled")
  // Adopted wins over everything: the invoice that links it is the live invoice.
  assert.equal(classifyExternalPo({ ...base, adopted: true, live_invoice_no: "X" }), "adopted")
})

test("an invoice SKU the Uniware PO doesn't carry blocks the adopt", () => {
  const items = [{ sku_code: "MCaf397_WB", qty: 3480, unit_price: null, mrp: null }]
  assert.deepEqual(skusMissingFromPo(["mcaf397_wb"], items), [])
  assert.deepEqual(skusMissingFromPo(["MCaf397_WB", "MCaf402", "MCaf402", ""], items), ["MCaf402"])
})
