import { test } from "node:test"
import assert from "node:assert/strict"
import { groupEmailLists, tabOf } from "../../app/po-tracking/po-procurement/entity-emails/email-lists"

test("the three special-PO types share one tab", () => {
  assert.deepEqual(["npd", "tech_transfer", "cpr", "employee", "mfg"].map(tabOf), ["special", "special", "special", "employee", "mfg"])
})

const names = { mfg: new Map([["MFG-005-NGE", "N.G. Electro"]]), vendor: new Map<string, string>() }
const row = (id: number, entity_type: string, entity_code: string, legal_entity_code: string | null = null, status = "active") =>
  ({ id, entity_type, entity_code, legal_entity_code, status })

test("one list per type, code and legal entity, manufacturers first", () => {
  const lists = groupEmailLists([
    row(1, "warehouse", "Gurgaon", "PEP"),
    row(2, "mfg", "MFG-005-NGE"),
    row(3, "warehouse", "Gurgaon"),
    row(4, "mfg", "MFG-005-NGE", null, "inactive"),
  ], names)
  assert.deepEqual(lists.map((l) => l.title), ["N.G. Electro (MFG-005-NGE)", "Gurgaon", "Gurgaon · PEP"])
  assert.equal(lists[0].rows.length, 2)
  assert.equal(lists[0].active, 1, "a paused address is listed but not counted")
})

test("the '*' wildcard reads by type: every manufacturer for colleagues, every warehouse for a warehouse", () => {
  const [emp, wh] = groupEmailLists([row(1, "employee", "*"), row(2, "warehouse", "*")], names).sort((a) => (a.badge === "Colleagues" ? -1 : 1))
  assert.equal(emp.title, "Every manufacturer")
  assert.equal(wh.title, "All warehouses")
})

test("a shared warehouse list shows every facility at the site; an entity-only list shows its own", () => {
  const facilities = new Map([["Gurgaon", [
    { entity_code: "PEP", facility_code: "GGN_WAREHOUSE" }, { entity_code: "KRT", facility_code: "HYP_B2B_GGN" },
  ]]])
  const lists = groupEmailLists([row(1, "warehouse", "Gurgaon"), row(2, "warehouse", "Gurgaon", "KRT"), row(3, "warehouse", "*")], { ...names, facilities })
  const by = Object.fromEntries(lists.map((l) => [l.title, l.codes]))
  assert.deepEqual(by["Gurgaon"], ["GGN_WAREHOUSE", "HYP_B2B_GGN"])
  assert.deepEqual(by["Gurgaon · KRT"], ["HYP_B2B_GGN"])
  assert.deepEqual(by["All warehouses"], [])
})

test("special-PO lists say the manufacturer is skipped", () => {
  const [npd] = groupEmailLists([row(1, "npd", "MFG-005-NGE")], names)
  assert.equal(npd.badge, "NPD PO")
  assert.match(npd.description, /instead of the manufacturer/)
})
