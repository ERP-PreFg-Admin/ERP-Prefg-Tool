/**
 * The /masters/warehouses filter predicate. Pure — no DB, no network.
 *
 * Worth pinning because the table's unit is a (location, legal entity) PAIR, not a
 * location, and two of the five filters read the pair's value with the location's
 * as a fallback. Getting that backwards shows a Pep row under a Kreative filter,
 * which is exactly the confusion this screen exists to remove.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { NO_FILTERS, typeOf, statusOf, matchesRow, type Row } from "../../app/masters/warehouses/filters"

/** A location under one entity. Only the fields the predicate reads are real; the
 *  casts keep the fixture to the point rather than restating both row types. */
function row(over: {
  entity?: string
  zone?: string | null
  whType?: string
  detail?: Record<string, unknown> | null
  name?: string
} = {}): Row {
  const { entity = "PEP", zone = "North", whType = "MWH", detail = {}, name = "GGN MW" } = over
  return {
    warehouse: { id: 1, name, location: "Gurugram", state: "Haryana", zone, type: whType, status: "active" } as unknown as Row["warehouse"],
    entity: { id: 1, code: entity, legal_name: `${entity} Pvt Ltd`, pan: null } as unknown as Row["entity"],
    detail: detail === null
      ? null
      : ({ facility_code: "GGN_WAREHOUSE", status: "active", type: null, ...detail } as unknown as Row["detail"]),
    key: `1:${entity}`,
  }
}

const NO_SEARCH = ""

test("no filters and no search matches everything", () => {
  assert.equal(matchesRow(row(), NO_FILTERS, NO_SEARCH), true)
  assert.equal(matchesRow(row({ detail: null }), NO_FILTERS, NO_SEARCH), true)
})

test("the entity filter separates the two companies' rows", () => {
  const pep = row({ entity: "PEP" })
  const kreative = row({ entity: "KREATIVE" })
  const onlyPep = { ...NO_FILTERS, entity: "PEP" }
  assert.equal(matchesRow(pep, onlyPep, NO_SEARCH), true)
  assert.equal(matchesRow(kreative, onlyPep, NO_SEARCH), false)
})

test("the per-entity type overrides the location's", () => {
  // The location is a mother warehouse, but this entity runs it as a child.
  const overridden = row({ whType: "MWH", detail: { type: "CWH" } })
  assert.equal(typeOf(overridden), "CWH")
  assert.equal(matchesRow(overridden, { ...NO_FILTERS, type: "CWH" }, NO_SEARCH), true)
  assert.equal(matchesRow(overridden, { ...NO_FILTERS, type: "MWH" }, NO_SEARCH), false)
})

test("the location's type is the fallback when the pair sets none", () => {
  const inherited = row({ whType: "MWH", detail: { type: null } })
  assert.equal(typeOf(inherited), "MWH")
  assert.equal(matchesRow(inherited, { ...NO_FILTERS, type: "MWH" }, NO_SEARCH), true)
})

test("status comes from the pair, not the location", () => {
  // Live location, but this entity is not trading here.
  const inactiveHere = row({ detail: { status: "inactive" } })
  assert.equal(statusOf(inactiveHere), "inactive")
  assert.equal(matchesRow(inactiveHere, { ...NO_FILTERS, status: "active" }, NO_SEARCH), false)
  assert.equal(matchesRow(inactiveHere, { ...NO_FILTERS, status: "inactive" }, NO_SEARCH), true)
})

test("a pair with no row at all falls back to the location's status", () => {
  const missing = row({ detail: null })
  assert.equal(statusOf(missing), "active")
  assert.equal(matchesRow(missing, { ...NO_FILTERS, status: "active" }, NO_SEARCH), true)
})

test("'not configured' catches a blank facility, not just a missing row", () => {
  const notConfigured = { ...NO_FILTERS, configured: "no" }
  const configured = { ...NO_FILTERS, configured: "yes" }

  // No child row — nothing to inward with.
  assert.equal(matchesRow(row({ detail: null }), notConfigured, NO_SEARCH), true)
  // A row exists but its facility is blank, which blocks inwarding just the same.
  assert.equal(matchesRow(row({ detail: { facility_code: "" } }), notConfigured, NO_SEARCH), true)
  assert.equal(matchesRow(row({ detail: { facility_code: null } }), notConfigured, NO_SEARCH), true)
  // A real facility is configured, and must not show under "not configured".
  assert.equal(matchesRow(row(), notConfigured, NO_SEARCH), false)
  assert.equal(matchesRow(row(), configured, NO_SEARCH), true)
  assert.equal(matchesRow(row({ detail: { facility_code: "" } }), configured, NO_SEARCH), false)
})

test("the zone filter reads the location", () => {
  assert.equal(matchesRow(row({ zone: "West" }), { ...NO_FILTERS, zone: "West" }, NO_SEARCH), true)
  assert.equal(matchesRow(row({ zone: "West" }), { ...NO_FILTERS, zone: "North" }, NO_SEARCH), false)
  // A location with no zone must not match a zone filter.
  assert.equal(matchesRow(row({ zone: null }), { ...NO_FILTERS, zone: "North" }, NO_SEARCH), false)
})

test("search is case-insensitive and spans the facility, entity and GSTIN", () => {
  const r = row({ detail: { facility_code: "HYP_B2B_GGN", ship_to_gstin: "06AAICP2804J1ZG" } })
  assert.equal(matchesRow(r, NO_FILTERS, "hyp_b2b"), true)
  assert.equal(matchesRow(r, NO_FILTERS, "aaicp"), true)
  assert.equal(matchesRow(r, NO_FILTERS, "gurugram"), true)
  assert.equal(matchesRow(r, NO_FILTERS, "pep"), true)
  assert.equal(matchesRow(r, NO_FILTERS, "  ggn mw  "), true, "search is trimmed")
  assert.equal(matchesRow(r, NO_FILTERS, "bhiwandi"), false)
})

test("search does not crash on a pair with no child row", () => {
  assert.equal(matchesRow(row({ detail: null }), NO_FILTERS, "ggn"), true)
  assert.equal(matchesRow(row({ detail: null }), NO_FILTERS, "hyp_b2b"), false)
})

test("filters AND together with each other and with search", () => {
  const r = row({ entity: "KREATIVE", zone: "West", detail: { facility_code: "MUM_KRE" } })
  const both = { ...NO_FILTERS, entity: "KREATIVE", zone: "West" }
  assert.equal(matchesRow(r, both, "mum"), true)
  // Every clause has to hold — a matching search does not rescue a failed filter.
  assert.equal(matchesRow(r, { ...both, entity: "PEP" }, "mum"), false)
  assert.equal(matchesRow(r, both, "nagpur"), false)
})
