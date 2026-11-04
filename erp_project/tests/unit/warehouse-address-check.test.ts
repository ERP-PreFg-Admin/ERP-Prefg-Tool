// The Lucknow case of 2026-11-03: the new address went into "as printed" only.
import { test } from "node:test"
import assert from "node:assert/strict"
import { printedOnlyShipToChanges, shipToMismatch } from "../../app/masters/warehouses/address-check"

const amausi = {
  ship_to_line1: "Khasra No. 486, Bhagwati Vanaspati (old Dalda Factory)",
  ship_to_line2: "Amausi Industrial Area, Amausi",
  ship_to_city: "Lucknow",
  ship_to_state: "Uttar Pradesh",
  ship_to_pincode: "226008",
  ship_to_address: "Khasra No. 486, Amausi Industrial Area, Lucknow, Uttar Pradesh - 226008",
}
const khatola = "Big Foot Retail Pvt. Ltd. Plot Part Khasra No.-733 Min, Village Khatola, Lucknow, UP 226301 India"

test("a printed PIN that differs from the Pincode field warns", () => {
  const w = shipToMismatch({ ...amausi, ship_to_address: khatola }, amausi)
  assert.match(w ?? "", /226301.*226008/)
})

test("same PIN, or no PIN in the printed text, gives no PIN warning", () => {
  assert.equal(shipToMismatch(amausi, amausi), null)
  assert.equal(shipToMismatch({ ...amausi, ship_to_address: "" }, amausi), null)
})

test("changing only the printed text, with no PIN in it, still warns", () => {
  const w = shipToMismatch({ ...amausi, ship_to_address: "Near Amausi Railway Station, Lucknow" }, amausi)
  assert.match(w ?? "", /Only the printed address changed/)
})

test("printed and structured updated together: no warning", () => {
  const moved = { ...amausi, ship_to_line1: "Plot Part Khasra No.-733 Min", ship_to_pincode: "226301", ship_to_address: khatola }
  assert.equal(shipToMismatch(moved, amausi), null)
})

test("adding a warehouse (no initial) only checks the PIN", () => {
  assert.equal(shipToMismatch({ ...amausi, ship_to_address: "Lucknow" }), null)
})

test("approval note: printed-only change per entity", () => {
  assert.deepEqual(printedOnlyShipToChanges(["ship_to_address:KREATIVE"]), ["KREATIVE"])
  assert.deepEqual(printedOnlyShipToChanges(["bill_to_address:PEP", "ship_to_address:PEP"]), ["PEP"])
  assert.deepEqual(printedOnlyShipToChanges(["ship_to_address:PEP", "ship_to_pincode:PEP"]), [])
  assert.deepEqual(printedOnlyShipToChanges(["zone", "ship_to_line1:PEP"]), [])
})
