// The PO destination dropdown's filter. Pure — no DB, no React.
//
// Worth pinning because both failure directions are silent. Too NARROW and a
// destination vanishes from the dropdown with no message saying why. Too WIDE and
// the PO is created happily, then fails at inwarding — facilityByDestinationAndPan
// finds no facility for that (site, entity) pair, so the warehouse mail goes out
// with no Uniware document attached and nobody learns which choice caused it.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  warehousesForEntity,
  warehouseLabel,
  warehouseKey,
  destFilterValue,
  destFilterLabel,
  destFilterSelection,
  parseDestFilter,
} from "../../app/po-tracking/po-procurement/po-utils"
import type { WarehouseOption } from "../../app/po-tracking/po-procurement/po-types"

const wh = (
  id: number,
  name: string,
  entity_code: string | null,
  facility_code: string | null = null,
  type: "MWH" | "CWH" = "CWH"
): WarehouseOption => ({
  id, name, location: name, zone: "West", type, entity_code, facility_code,
  // Not used by warehousesForEntity — see invoice-mapping.test.ts for the
  // PIN-code matching these two carry.
  ship_to_pincode: null, bill_to_address: null,
})

// What the query returns: one row per (site, entity). Mumbai runs under both,
// Guwahati only under Pep, and Kolkata has no per-entity row yet.
const OPTIONS: WarehouseOption[] = [
  wh(1, "Mumbai MWH", "PEP", "MUM_PEP", "MWH"),
  wh(1, "Mumbai MWH", "KREATIVE", "MUM_KRE", "MWH"),
  wh(2, "Guwahati CWH", "PEP", "GHY_PEP"),
  wh(3, "Kolkata CWH", null, null),
]

test("an entity sees its own sites plus the unconfigured ones", () => {
  const pep = warehousesForEntity(OPTIONS, "PEP")
  assert.deepEqual(pep.map((w) => w.name), ["Mumbai MWH", "Guwahati CWH", "Kolkata CWH"])
  assert.equal(pep.find((w) => w.name === "Mumbai MWH")?.facility_code, "MUM_PEP")

  const kre = warehousesForEntity(OPTIONS, "KREATIVE")
  // Guwahati has a Pep row only, so Kreative must not be offered it.
  assert.deepEqual(kre.map((w) => w.name), ["Mumbai MWH", "Kolkata CWH"])
  assert.equal(kre.find((w) => w.name === "Mumbai MWH")?.facility_code, "MUM_KRE")
})

test("a site with no per-entity row stays selectable for everyone", () => {
  // NULL entity_code means "not configured yet", not "belongs to no one". Hiding
  // it would remove a destination with nothing on screen explaining the absence.
  for (const entity of ["PEP", "KREATIVE", "SOMETHING_NEW"]) {
    const names = warehousesForEntity(OPTIONS, entity).map((w) => w.name)
    assert.ok(names.includes("Kolkata CWH"), `${entity} must still see the unconfigured site`)
  }
})

test("a null entity does not narrow, and shows no facility code", () => {
  // An unattributed SKU. Which entity's facility applies is genuinely unknown, and
  // a plausible-looking wrong code is worse than none.
  const all = warehousesForEntity(OPTIONS, null)
  assert.deepEqual(all.map((w) => w.name), ["Mumbai MWH", "Guwahati CWH", "Kolkata CWH"])
  assert.deepEqual(all.map((w) => w.facility_code), [null, null, null])
  assert.deepEqual(all.map((w) => w.entity_code), [null, null, null])

  // undefined behaves the same — callers pass `?? null` inconsistently.
  assert.equal(warehousesForEntity(OPTIONS, undefined).length, 3)
})

test("one entry per site name, never a duplicate", () => {
  // `destination` stores the NAME, so two rows with the same name would be
  // indistinguishable in the dropdown and the user couldn't tell which they picked.
  for (const entity of ["PEP", "KREATIVE", null]) {
    const names = warehousesForEntity(OPTIONS, entity).map((w) => w.name)
    assert.equal(new Set(names).size, names.length, `duplicate site for ${entity}`)
  }
})

test("a row naming the entity beats an unconfigured row for the same site", () => {
  // Mid-migration a site can have both. The specific row carries the facility, so
  // it has to win regardless of which order the query returned them in.
  const forward = [wh(9, "Mixed", null), wh(9, "Mixed", "PEP", "MIX_PEP")]
  const reverse = [wh(9, "Mixed", "PEP", "MIX_PEP"), wh(9, "Mixed", null)]
  for (const opts of [forward, reverse]) {
    const [only] = warehousesForEntity(opts, "PEP")
    assert.equal(only.facility_code, "MIX_PEP")
  }
})

test("input order is preserved, so mother warehouses stay first", () => {
  // The query sorts type DESC (MWH before CWH) and the dialogs default to the
  // first MWH they find. A Map-based dedupe keeps insertion order; this pins it.
  assert.deepEqual(
    warehousesForEntity(OPTIONS, "PEP").map((w) => w.type),
    ["MWH", "CWH", "CWH"]
  )
})

test("an empty option list yields nothing rather than throwing", () => {
  assert.deepEqual(warehousesForEntity([], "PEP"), [])
  assert.deepEqual(warehousesForEntity([], null), [])
})

// ── Label ────────────────────────────────────────────────────────────────────

test("the label carries the Uniware facility code", () => {
  assert.equal(
    warehouseLabel(wh(1, "Mumbai", "PEP", "MUM_PEP", "MWH")),
    "Mumbai (MWH) · MUM_PEP"
  )
})

test("a known entity with no facility says so instead of going quiet", () => {
  // An unset facility breaks inwarding later, and the dropdown is the last place
  // anyone sees the site and its facility together.
  assert.equal(
    warehouseLabel(wh(2, "Guwahati", "KREATIVE", null)),
    "Guwahati (CWH) · facility not set"
  )
  // But with no entity there is nothing to be missing — stay silent.
  assert.equal(warehouseLabel(wh(3, "Kolkata", null, null)), "Kolkata (CWH)")
})

test("the zone is not in the label, whatever it holds", () => {
  // `name` is the city, so the zone restated it and pushed the facility code off
  // the end of a closed <select>. Pinned so it doesn't creep back in.
  const zoned: WarehouseOption = { ...wh(4, "Guwahati", "PEP", "GHY_PEP"), zone: "North East" }
  assert.equal(warehouseLabel(zoned), "Guwahati (CWH) · GHY_PEP")
  assert.ok(!warehouseLabel(zoned).includes("North East"))
})

test("the React key separates a site's two entity rows", () => {
  // `id` repeats across them, so id alone would collide and React would reuse the
  // wrong option element.
  assert.notEqual(
    warehouseKey(wh(1, "Mumbai MWH", "PEP")),
    warehouseKey(wh(1, "Mumbai MWH", "KREATIVE"))
  )
  assert.equal(warehouseKey(wh(3, "Kolkata CWH", null)), "3-any")
})

/* ── The destination FILTER ─────────────────────────────────────────────────────
 * Different question from warehousesForEntity: the filter keeps every
 * (site, entity) row as its OWN option, because Pep's Mumbai facility and
 * Kreative's are different places to send goods. purchase_orders.destination stores
 * only the shared site name, so the option value packs both halves and the query
 * filters on the site plus the PO's own entity.                                  */

test("each (site, entity) pair is its own filter value", () => {
  assert.deepEqual(
    OPTIONS.map(destFilterValue),
    ["Mumbai MWH|PEP", "Mumbai MWH|KREATIVE", "Guwahati CWH|PEP", "Kolkata CWH"]
  )
  // Distinct values, or the two Mumbais would be the same option to the browser.
  assert.equal(new Set(OPTIONS.map(destFilterValue)).size, OPTIONS.length)
})

test("a site with no per-entity row filters by name alone", () => {
  // Nothing to pair it with, and its POs carry whatever entity their SKU has.
  assert.equal(destFilterValue(wh(3, "Kolkata CWH", null)), "Kolkata CWH")
  assert.deepEqual(parseDestFilter("Kolkata CWH"), { destination: "Kolkata CWH", destEntity: "" })
})

test("the value round-trips through the two URL params", () => {
  for (const w of OPTIONS) {
    const { destination, destEntity } = parseDestFilter(destFilterValue(w))
    assert.equal(destination, w.name)
    assert.equal(destEntity, w.entity_code ?? "")
    // …and back, so the <select> re-marks the right option after a reload.
    assert.equal(destFilterSelection(destination, destEntity), destFilterValue(w))
  }
})

test("a bare name from an older bookmark still parses", () => {
  // ?destination=Mumbai%20MWH predates the entity half; it must filter by site
  // rather than 404 or match nothing.
  assert.deepEqual(parseDestFilter("Mumbai MWH"), { destination: "Mumbai MWH", destEntity: "" })
  assert.equal(destFilterSelection("Mumbai MWH", ""), "Mumbai MWH")
})

test("the empty value is 'All Destinations', not a site named ''", () => {
  assert.deepEqual(parseDestFilter(""), { destination: "", destEntity: "" })
  assert.equal(destFilterSelection("", ""), "")
})

test("a name containing the separator splits at the FIRST one only", () => {
  // indexOf, not split — a warehouse named "A|B" would otherwise lose its entity.
  assert.deepEqual(parseDestFilter("A|B|PEP"), { destination: "A", destEntity: "B|PEP" })
})

test("the filter label names the entity, since the two sites sit side by side", () => {
  assert.equal(destFilterLabel(OPTIONS[0]), "Mumbai MWH · PEP — MUM_PEP")
  assert.equal(destFilterLabel(OPTIONS[1]), "Mumbai MWH · KREATIVE — MUM_KRE")
  // Unconfigured site: no entity to name and no code to show.
  assert.equal(destFilterLabel(OPTIONS[3]), "Kolkata CWH (CWH)")
})

test("a configured pair with no facility code is called out, not left blank", () => {
  assert.equal(destFilterLabel(wh(5, "Nagpur", "KREATIVE", null)), "Nagpur · KREATIVE — facility not set")
})
