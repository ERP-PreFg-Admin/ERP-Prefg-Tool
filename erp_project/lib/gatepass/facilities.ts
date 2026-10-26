// GatePass per-facility config. The facility LIST is not here: it is read from Warehouse Master
// (active CWH facilities, lib/services/gatepass.ts). Codes keep Uniware's inconsistent casing.

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
