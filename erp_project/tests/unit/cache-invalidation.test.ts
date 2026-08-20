/**
 * Every approval module that changes a cached reference list must invalidate it.
 *
 * This existed as three `if (module === ...)` lines in the approvals route and
 * covered RM_RATE, PM_RATE and WAREHOUSE. MFG was missing, so an approved
 * manufacturer stayed absent from the PO and invoice dropdowns until a 120s timer
 * expired — indistinguishable, from the user's side, from the master not saving.
 *
 * The failure mode is an OMISSION, which no amount of testing the present entries
 * catches. So these tests check the map against MODULE_HANDLERS: add a module that
 * writes a master and forget its tags, and the last test says so by name.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { CACHE_TAGS_BY_MODULE } from "../../lib/cached-reference-data"

/** The tags that actually exist on a cache in lib/cached-reference-data.ts. */
const REAL_TAGS = new Set([
  "ref:vendors", "ref:manufacturers", "ref:rm", "ref:pm", "ref:skus",
  "ref:po-options", "ref:mfg-rm-rates", "ref:mfg-pm-rates",
])

test("every mapped tag is a tag some cache actually carries", () => {
  // A typo'd tag invalidates nothing and fails silently — revalidateTag does not
  // complain about a name no cache uses.
  for (const [moduleCode, tags] of Object.entries(CACHE_TAGS_BY_MODULE)) {
    for (const tag of tags) {
      assert.ok(REAL_TAGS.has(tag), `${moduleCode} maps to "${tag}", which no cache declares`)
    }
  }
})

test("the modules feeding the PO and invoice dropdowns invalidate ref:po-options", () => {
  // getPoDropdownOptions is ONE cache holding SKUs, manufacturers and warehouses,
  // so all three families have to bust it. This is the regression: MFG did not.
  for (const moduleCode of ["MFG", "MFG_BULK", "SKU", "WAREHOUSE"]) {
    assert.ok(
      CACHE_TAGS_BY_MODULE[moduleCode]?.includes("ref:po-options"),
      `${moduleCode} must invalidate ref:po-options, or an approved ${moduleCode} is missing ` +
      `from the invoice dialog's dropdowns until the timer expires`
    )
  }
})

test("a bulk module invalidates whatever its singular counterpart does", () => {
  // Bulk upload is how several masters arrive at once, so omitting it makes the
  // highest-volume path the one that does not refresh.
  for (const [bulk, singular] of [
    ["MFG_BULK", "MFG"],
    ["VENDOR_BULK", "VENDOR"],
    ["RM_BULK", "RM_MAT"],
    ["PM_BULK", "PM_MAT"],
    ["RM_RATE_BULK", "RM_RATE"],
    ["PM_RATE_BULK", "PM_RATE"],
  ] as [string, string][]) {
    const a = CACHE_TAGS_BY_MODULE[bulk] ?? []
    const b = CACHE_TAGS_BY_MODULE[singular] ?? []
    assert.ok(b.length > 0, `${singular} has no tags, so the pairing cannot be checked`)
    for (const tag of b) {
      assert.ok(a.includes(tag), `${bulk} is missing "${tag}", which ${singular} invalidates`)
    }
  }
})

test("rate approvals still refresh the Manufacturing rate tabs", () => {
  // The behaviour that already worked, kept from regressing when the ifs became a map.
  assert.deepEqual(CACHE_TAGS_BY_MODULE.RM_RATE, ["ref:mfg-rm-rates"])
  assert.deepEqual(CACHE_TAGS_BY_MODULE.PM_RATE, ["ref:mfg-pm-rates"])
})

test("every registered module that writes a master declares its tags", async () => {
  // The catch-all. MODULE_HANDLERS is the list of things an approval can apply, so
  // a new master module shows up here the moment it is registered.
  const { MODULE_HANDLERS } = await import("../../lib/approvals/module-handlers")

  /** Modules that legitimately invalidate nothing, with the reason. */
  const NO_CACHE: Record<string, string> = {
    PO: "purchase_orders is never cached — the PO list is read live",
    PO_BULK: "same as PO",
    BOM: "recipes are read live; no cached recipe list exists",
    BOM_BULK: "same as BOM",
    MFG_MISC: "bom_misc feeds costing, which reads live",
    MFG_MISC_BULK: "same as MFG_MISC",
    // Vendor rates feed the RM/PM cost masters, which are read live per material.
    RM_VRM_BULK: "covered by ref:rm via RM_VRM",
    PM_VRM_BULK: "covered by ref:pm via PM_VRM",
  }

  const missing = Object.keys(MODULE_HANDLERS).filter(
    (m) => !CACHE_TAGS_BY_MODULE[m] && !(m in NO_CACHE)
  )
  assert.deepEqual(
    missing, [],
    `these approval modules declare no cache tags and are not listed as exempt — ` +
    `add them to CACHE_TAGS_BY_MODULE, or to NO_CACHE here with the reason: ${missing.join(", ")}`
  )
})
