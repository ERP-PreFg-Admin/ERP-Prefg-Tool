// The buyer/seller GSTIN filter.
//
// This exists because the filter went missing twice while everything still
// compiled and every other check stayed green: `sellerGstins` was assigned the
// unfiltered list, so the variable read as safe at both call sites while doing
// nothing. tsc cannot catch that — only an assertion on the values can.
//
// What it protects: `lookupMfgByGstin` and `strategyFor` both take the FIRST
// entry that matches. If one of our own GSTINs reaches them, every supplier's
// invoice resolves to whichever manufacturer holds it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { panOf, isOurs, sellerGstinsOf, OUR_PANS } from "../../lib/invoice/gstin"

// Real values, from the sample set. PEP invoices under several state codes, which
// is the whole reason the comparison is on PAN rather than the full GSTIN.
const OURS_ASSAM = "18AAICP2804J1ZB"
const OURS_KARNATAKA = "29AAICP2804J1Z8"
const OURS_MAHARASHTRA = "27AAICP2804J1ZC"
const REVE = "27AAKFR0481L1ZT"

test("panOf lifts the 10-char PAN out of a GSTIN", () => {
  assert.equal(panOf(OURS_ASSAM), "AAICP2804J")
  assert.equal(panOf(REVE), "AAKFR0481L")
})

test("the same PAN in a different state is still ours", () => {
  // Only the leading state code differs across these three.
  for (const g of [OURS_ASSAM, OURS_KARNATAKA, OURS_MAHARASHTRA]) {
    assert.equal(isOurs(g), true, `${g} should be recognised as ours`)
  }
})

test("a supplier GSTIN is not ours", () => {
  assert.equal(isOurs(REVE), false)
})

test("sellerGstinsOf drops ours and keeps the supplier's", () => {
  // Buyer first, which is the order that made the original bug dangerous:
  // lookupMfgByGstin takes the first match it finds.
  assert.deepEqual(sellerGstinsOf([OURS_ASSAM, REVE]), [REVE])
  assert.deepEqual(sellerGstinsOf([REVE, OURS_ASSAM]), [REVE])
})

test("a document carrying only our GSTINs yields no seller", () => {
  // KAPCO and N.G. Electro really are like this — their own number is in an
  // image. The correct outcome is an empty list, NOT a fallback to the buyer.
  assert.deepEqual(sellerGstinsOf([OURS_KARNATAKA, OURS_ASSAM]), [])
})

test("filtering is not the identity function", () => {
  // The regression that actually shipped: sellerGstins === gstins. Guards against
  // the filter being dropped again while the variable keeps its reassuring name.
  const all = [OURS_ASSAM, REVE, OURS_KARNATAKA]
  assert.notDeepEqual(sellerGstinsOf(all), all)
  assert.equal(sellerGstinsOf(all).length, 1)
})

test("every PAN we claim is a well-formed PAN", () => {
  // A typo here silently un-protects one of our registrations.
  for (const pan of OUR_PANS) {
    assert.match(pan, /^[A-Z]{5}\d{4}[A-Z]$/, `${pan} is not PAN-shaped`)
  }
})
