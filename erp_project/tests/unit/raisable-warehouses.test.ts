import { test } from "node:test"
import assert from "node:assert/strict"
import { raisableWarehouses } from "../../app/po-tracking/po-procurement/po-utils"
import type { WarehouseOption } from "../../app/po-tracking/po-procurement/po-types"

const wh = (name: string, site_status: string | null): WarehouseOption => ({
  id: 1, code: null, name, location: null, zone: null, type: "CWH", site_status,
  entity_code: "PEP", facility_code: null, ship_to_pincode: null, bill_to_address: null,
})

test("an inactive location is not offered for a new PO; active and unknown are", () => {
  const out = raisableWarehouses([wh("Kolkata", "inactive"), wh("Kolkata - New", "active"), wh("Mumbai", null)])
  assert.deepEqual(out.map((w) => w.name), ["Kolkata - New", "Mumbai"])
})
