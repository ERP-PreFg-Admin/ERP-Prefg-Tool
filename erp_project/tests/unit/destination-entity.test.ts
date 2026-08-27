// The destination × legal-entity rule exists in TWO places, and they must agree:
//
//   warehousesForEntity()  — decides what the dropdown OFFERS   (po-utils.ts)
//   destinationAllowed()   — decides what the API ACCEPTS       (lib/po/po-guard.ts)
//
// Disagreement is worse than either being wrong alone. Stricter API: the dropdown
// offers a destination the server then refuses, and the user has no way to act on
// the error — they picked from the only list they were shown. Looser API: the guard
// isn't guarding, and the mismatch surfaces days later at inwarding.
//
// So most of this file is a parity check driven off one set of fixtures.
import { test } from "node:test"
import assert from "node:assert/strict"
import { destinationAllowed, type DestinationEntityRow } from "../../lib/po/po-guard"
import { warehousesForEntity } from "../../app/po-tracking/po-procurement/po-utils"
import type { WarehouseOption } from "../../app/po-tracking/po-procurement/po-types"

const wh = (
  id: number, name: string, entity_code: string | null, facility_code: string | null = null
): WarehouseOption => ({
  // `code` is the site's own short code — it labels the dropdown but plays no
  // part in which entity a destination serves, so it stays null here.
  id, code: null, name, location: name, zone: null, type: "CWH", entity_code, facility_code,
  // Addresses play no part in destinationAllowed — see invoice-mapping.test.ts
  // for the PIN-code matching they exist for.
  ship_to_pincode: null, bill_to_address: null,
})

// Mumbai runs under both; Guwahati under Pep only; Kolkata is not set up yet.
const OPTIONS: WarehouseOption[] = [
  wh(1, "Mumbai", "PEP", "MUM_PEP"),
  wh(1, "Mumbai", "KREATIVE", "MUM_KRE"),
  wh(2, "Guwahati", "PEP", "GHY_PEP"),
  wh(3, "Kolkata", null),
]

/** The row selectDestinationEntityCheck would return, derived from the fixtures so
 *  both sides are answering about the same world. EXISTS yields 1|0. */
function checkRow(entityCode: string | null, site: string): DestinationEntityRow {
  const rowsForSite = OPTIONS.filter((w) => w.name === site)
  return {
    entity_code: entityCode,
    site_configured: rowsForSite.some((w) => w.entity_code) ? 1 : 0,
    serves: rowsForSite.some((w) => w.entity_code === entityCode) ? 1 : 0,
  }
}

const SITES = ["Mumbai", "Guwahati", "Kolkata"]
const ENTITIES: (string | null)[] = ["PEP", "KREATIVE", null]

test("the API accepts exactly what the dropdown offers — for every combination", () => {
  for (const entity of ENTITIES) {
    const offered = new Set(warehousesForEntity(OPTIONS, entity).map((w) => w.name))
    for (const site of SITES) {
      assert.equal(
        destinationAllowed(checkRow(entity, site)),
        offered.has(site),
        `entity=${entity} site=${site}: dropdown ${offered.has(site) ? "offers" : "hides"} it, ` +
        `guard ${destinationAllowed(checkRow(entity, site)) ? "accepts" : "rejects"} it`
      )
    }
  }
})

// ── The three rules, stated directly ─────────────────────────────────────────

test("the other entity's site is refused", () => {
  // The whole point: Guwahati has a Pep row only.
  assert.equal(destinationAllowed(checkRow("KREATIVE", "Guwahati")), false)
  assert.equal(destinationAllowed(checkRow("PEP", "Guwahati")), true)
})

test("a site both entities operate is fine for either", () => {
  assert.equal(destinationAllowed(checkRow("PEP", "Mumbai")), true)
  assert.equal(destinationAllowed(checkRow("KREATIVE", "Mumbai")), true)
})

test("an unconfigured site is allowed for everyone", () => {
  // site_configured = 0 means "not set up yet", NOT "serves nobody". Refusing would
  // block a destination over a data gap the user can't see from the PO screen.
  for (const entity of ENTITIES) {
    assert.equal(destinationAllowed(checkRow(entity, "Kolkata")), true, `entity=${entity}`)
  }
})

test("an unattributed SKU is never restricted", () => {
  // entity_code NULL — an unmapped brand, or a SKU with no brand at all. Same
  // allow-when-unknown convention as the brand scope predicates.
  for (const site of SITES) {
    assert.equal(destinationAllowed(checkRow(null, site)), true, `site=${site}`)
  }
})

// ── Shapes MySQL actually returns ────────────────────────────────────────────

test("EXISTS values are read numerically, whether they arrive as 1 or '1'", () => {
  // mysql2 can hand back either depending on the driver path, and a bare truthiness
  // check on the string "0" would invert the unconfigured-site rule.
  assert.equal(destinationAllowed({ entity_code: "PEP", site_configured: "0", serves: "0" }), true)
  assert.equal(destinationAllowed({ entity_code: "PEP", site_configured: "1", serves: "0" }), false)
  assert.equal(destinationAllowed({ entity_code: "PEP", site_configured: "1", serves: "1" }), true)
})

test("an empty entity_code is treated as absent, not as a code", () => {
  assert.equal(destinationAllowed({ entity_code: "", site_configured: 1, serves: 0 }), true)
})
