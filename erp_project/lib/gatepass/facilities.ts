/**
 * The facilities the GatePass summary can be run for.
 *
 * ⚠️ This list is a CONSTANT, not a query. The app already knows its facilities
 * — `details_warehouse_entity.facility_code` holds them, joined to a warehouse
 * name and a legal entity — and this file deliberately does not read it, per the
 * brief for v1 ("use only the facilities in the code, don't touch the DB").
 *
 * The consequence, stated so it is a decision and not a surprise: this list and
 * Warehouse Master can drift, and nothing will notice. A facility added to the
 * business appears here only when someone edits this file.
 *
 * ponytail: hardcoded roster, no scope. Swap for `mfgFacilityMap.selectPoConfigs`
 * (active facilities, already carrying `wh_name` for the scope check) when the
 * screen needs to be entity-scoped or the drift starts to bite — that query also
 * makes `inScope(scope, "warehouse", …)` possible, which is impossible while the
 * only thing we know about a facility is its code.
 *
 * Spellings are Unicommerce's own and are inconsistent on purpose — `Mcaff_`,
 * `mCaff_` and `HYP_` all appear, and the API matches them exactly. Copied
 * verbatim from gatepass_summary.py; do not "tidy" the casing.
 *
 * Codes verified against live exports on 2026-08-28: mCaff_Ahmedabad (1,141
 * rows) and HYP_AHMD (558 rows) both return data on one token, so the two legal
 * entities share a tenant and no per-entity credential is needed.
 */

export const FACILITIES = [
  "HYP_AHMD", "HYP_DLGWHT", "HYP_SRBGLR", "HYP_DLNAG", "HYP_SPCHN", "HYP_SRGWHT",
  "HYP_SRHYD", "HYP_SRKOL", "HYP_SRLOK2", "Mcaff_Chennai", "mCaff_Guwahati",
  "mCaff_Mumbai", "mCaff_Lucknow2", "mCaff_Ahmedabad", "mCaff_Bangalore2",
  "mCaff_Guwahati2", "mCaff_Hyderabad2", "mCaff_Kolkata2", "mCaff_Lucknow3",
  "Mcaff_Nagpur",
] as const

export const DEFAULT_FACILITY = "mCaff_Ahmedabad"

/**
 * `partyCode` per facility — the party the gatepass is raised TO.
 *
 * ⚠️ **A party is configured PER FACILITY, and there is no global default.**
 * Learned the hard way on 2026-08-28: `Dry_Inv_CWH_Consumption` was set as one
 * value for everywhere, which created fine at Mcaff_Chennai and was rejected at
 * mCaff_Ahmedabad with `INVALID_PARTY_CODE`. Chennai simply happens to have that
 * party configured; Ahmedabad does not.
 *
 * These values are READ FROM THE LIVE TENANT — every gatepass raised this
 * financial year, grouped by facility, taking the one used for dry-inventory
 * consumption. They are not invented, but they ARE inferred from usage: nobody
 * has confirmed that the busiest dry party is the right one for this automation
 * at each site. Correct any that are wrong here, in one place.
 *
 * A facility absent from this map resolves to `null` and is REFUSED by
 * `blockers` before anything is sent. That is deliberate: a wrong party code
 * fails at create anyway, and a guessed one that happens to exist would print
 * the wrong destination on a real document — far worse than a refusal.
 *
 * Left out for want of evidence, and needing a human answer:
 *   HYP_SPCHN, mCaff_Mumbai, mCaff_Lucknow2, mCaff_Guwahati2 — no gatepasses at
 *     all this FY, so nothing to infer from.
 *   HYP_DLGWHT — one gatepass, to `Bad_to_Good_`; no dry-consumption party seen.
 *   Mcaff_Nagpur — only `Rework_GP_` and `Quarantine_Batch_Issue`.
 */
export const TO_PARTY: Record<string, string> = {
  // mCaffeine sites: "Dry_Inventory_" is the dry-consumption party in use.
  mCaff_Ahmedabad: "Dry_Inventory_",
  mCaff_Bangalore2: "Dry_Inventory_",
  mCaff_Guwahati: "Dry_Inventory_",
  mCaff_Hyderabad2: "Dry_Inventory_",
  mCaff_Kolkata2: "Dry_Inventory_",
  mCaff_Lucknow3: "Dry_Inventory_",

  // Chennai has its own, and it is the one code proven to create successfully.
  Mcaff_Chennai: "Dry_Inv_CWH_Consumption",

  // Hyphen sites mostly carry the "_Hyphen" suffixed party…
  HYP_SRBGLR: "Dry_Inventory_Hyphen",
  HYP_SRGWHT: "Dry_Inventory_Hyphen",
  HYP_SRHYD: "Dry_Inventory_Hyphen",
  HYP_SRKOL: "Dry_Inventory_Hyphen",
  // …but not all of them: these two use the unsuffixed and a site-specific one.
  HYP_AHMD: "Dry_Inventory_",
  HYP_SRLOK2: "Dry_Inventory_",
  HYP_DLNAG: "Dry_DVL_HYPNagpur_Consumption",
}

/** The party a facility's gatepass is raised to, or null when none is known. */
export function toPartyFor(facility: string): string | null {
  return TO_PARTY[facility]?.trim() || null
}

/**
 * Is this a facility we will run for?
 *
 * The API routes' guard, not a UI nicety. `facility_code` arrives from the
 * browser as a free string, and with no DB behind this screen the roster is the
 * *only* thing defining what a valid facility is — without this check a route
 * would forward any string a caller invented to Unicommerce under our
 * credentials.
 */
export function isKnownFacility(code: string): boolean {
  return (FACILITIES as readonly string[]).includes(code)
}
