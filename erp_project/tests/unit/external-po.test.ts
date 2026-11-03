// Uniware-only POs: what the sweep keeps from a detail call, and which ones Add Invoice may adopt.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  acceptedQty, allocateOpenPos, classifyExternalPo, invoiceNoFromReference, mapPoDetail, sameInvoiceNo, sameSkuQty,
  skusMissingFromPo,
} from "../../lib/uniware/external-po"

test("accepted qty is received less rejected, or the PO qty before anything arrives", () => {
  assert.equal(acceptedQty({ sku_code: "A", qty: 100, unit_price: null, mrp: null, received_qty: 96, rejected_qty: 4 }), 92)
  assert.equal(acceptedQty({ sku_code: "A", qty: 100, unit_price: null, mrp: null, received_qty: 0, rejected_qty: 0 }), 100)
  assert.equal(acceptedQty({ sku_code: "A", qty: 100, unit_price: null, mrp: null }), 100)
})

test("allocation takes the same warehouse first, then Mumbai, oldest first, never another warehouse", () => {
  const pos = [
    { id: 1, po_no: "P1", sku_code: "A", destination: "Mumbai", date: "2026-09-01", remaining: 50 },
    { id: 2, po_no: "P2", sku_code: "A", destination: "Hyderabad", date: "2026-10-01", remaining: 30 },
    { id: 3, po_no: "P3", sku_code: "A", destination: "Gurgaon", date: "2026-08-01", remaining: 500 },
  ]
  const item = { sku_code: "a", qty: 70, unit_price: 2, mrp: null }
  const { lines, shortfalls } = allocateOpenPos([item], pos, "Hyderabad")
  assert.deepEqual(lines.map((l) => [l.po_no, l.qty]), [["P2", 30], ["P1", 40]])
  assert.deepEqual(shortfalls, [])
  const short = allocateOpenPos([{ ...item, qty: 100 }], pos, "Hyderabad")
  assert.deepEqual(short.shortfalls, [{ sku_code: "a", needed: 100, available: 80 }])
})

test("a relink needs the same SKUs at the same total qty", () => {
  const po = [{ sku_code: "A", qty: 10 }, { sku_code: "B", qty: 5 }]
  assert.ok(sameSkuQty([{ sku_code: "a", qty: 4 }, { sku_code: "A", qty: "6" }, { sku_code: "B", qty: 5 }], po))
  assert.ok(!sameSkuQty([{ sku_code: "A", qty: 10 }], po))
  assert.ok(!sameSkuQty([{ sku_code: "A", qty: 10 }, { sku_code: "B", qty: 6 }], po))
})

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
  assert.deepEqual(m.items, [{ sku_code: "PMRAW133", qty: 2000, unit_price: 6.81, mrp: 0.01, received_qty: null, rejected_qty: null }])
})

test("a PO with no ReferenceNo stores null, not an empty string", () => {
  assert.equal(mapPoDetail({ customFieldValues: [{ fieldName: "ReferenceNo", fieldValue: " " }] }, []).reference_no, null)
  assert.equal(mapPoDetail({}, []).un_created_at, null)
})

test("only a live, all-FG PO whose invoice is not in the ERP is adoptable", () => {
  const base = { un_status: "COMPLETE", all_fg: true, adopted: false, live_invoice_no: null }
  assert.equal(classifyExternalPo(base), "missing")
  assert.equal(classifyExternalPo({ ...base, live_invoice_no: "KCPL/C2627/1218" }), "replacement")
  assert.equal(classifyExternalPo({ ...base, live_invoice_no: "KCPL/C2627/1218", live_invoice_grn_count: 0 }), "replacement")
  assert.equal(classifyExternalPo({ ...base, live_invoice_no: "SB/2413/26-27", live_invoice_grn_count: 1 }), "duplicate")
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
