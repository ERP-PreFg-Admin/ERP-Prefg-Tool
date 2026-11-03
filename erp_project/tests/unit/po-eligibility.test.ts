// Which POs an invoice line may book against — lib/invoice/po-eligibility.ts, shared by Add Invoice and the server.
import { test } from "node:test"
import assert from "node:assert/strict"
import { destinationTier, poDestinationLabel, referencePoBlock } from "../../lib/invoice/po-eligibility"

test("destination tiers: same, Mumbai fallback, other", () => {
  assert.equal(destinationTier("Gurgaon", "gurgaon "), 0)
  assert.equal(destinationTier(null, "Mumbai"), 0, "a PO with no destination is Mumbai's")
  assert.equal(destinationTier("Mumbai", "Gurgaon"), 1, "Mumbai is every warehouse's fallback")
  assert.equal(destinationTier("", "Gurgaon"), 1)
  assert.equal(destinationTier("Bangalore", "Gurgaon"), 2)
  assert.equal(destinationTier("Gurgaon", "Mumbai"), 2, "the fallback runs one way only")
  assert.equal(poDestinationLabel(null), "Mumbai (not set)")
})

test("a reference PO is refused for the wrong manufacturer, SKU or an inward PO", () => {
  const po = { id: 1, po_no: "MPO-1", mfg_id: 5, sku_code: "SKU-A", po_type: "normal" }
  assert.equal(referencePoBlock(po, { sku_code: "sku-a" }, 5), null)
  assert.match(String(referencePoBlock(undefined, {}, 5)), /no longer exists/)
  assert.match(String(referencePoBlock(po, { sku_code: "SKU-A" }, 6)), /another manufacturer/)
  assert.match(String(referencePoBlock(po, { sku_code: "SKU-B" }, 5)), /is for SKU-A/)
  assert.match(String(referencePoBlock({ ...po, po_type: "inward" }, {}, 5)), /inward PO/)
})
