/**
 * The gatepass dry run: code grammar, line items, and the refusals.
 *
 * Ports the `selftest()` blocks of gatepass_codes.py and
 * sale_order_to_gatepass.py. The blocker assertions matter most — they are the
 * only thing standing between this feature and posting a guessed payload at a
 * real facility.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  entityLetter, site, gatepassPrefix, canonicalGatepassCode, splitGatepassCode, CITY,
  dryGatepassPrefix, dryGatepassCode, nextSerialFrom,
} from "../../lib/gatepass/gatepass-code"
import {
  packageTypeItems, planFacility, blockers, buildGatepassPayload, gatepassReference, DEFAULT_TYPE,
} from "../../lib/gatepass/plan"
import { parseExportRows, summariseRows } from "../../lib/gatepass/summary"
import { TO_PARTY, toPartyFor, FACILITIES } from "../../lib/gatepass/facilities"

const APR_2026 = new Date("2026-06-01T00:00:00Z")   // FY 2627
const MAR_2026 = new Date("2026-03-15T00:00:00Z")   // FY 2526

const rows = (csv: string) => parseExportRows(csv)

// ── code grammar ────────────────────────────────────────────────────────────

test("entity comes from the facility code alone; B2B is not its own entity", () => {
  assert.equal(entityLetter("HYP_B2B_MUM2"), "H")
  assert.equal(entityLetter("HYP_SRHYD"), "H")
  assert.equal(entityLetter("MUM_WAREHOUSE2"), "M")
  assert.equal(entityLetter("mCaff_Ahmedabad"), "M")
  assert.equal(entityLetter("Mcaff_Nagpur"), "M")
})

test("the same city under two entities stays two series", () => {
  assert.equal(site("HYP_AHMD"), "H/AHM")
  assert.equal(site("mCaff_Ahmedabad"), "M/AHM")
  assert.equal(site("HYP_SPCHN"), "H/SRCHN")
  assert.equal(site("Mcaff_Chennai"), "M/CHN")
})

test("an unmapped facility gets no prefix rather than a guessed one", () => {
  assert.equal(site("NOT_A_FACILITY"), null)
  assert.equal(gatepassPrefix("NOT_A_FACILITY", APR_2026), null)
  assert.equal(canonicalGatepassCode("NOT_A_FACILITY", 7, APR_2026), null)
  // The facilities the page can select but this map still has no city for.
  for (const f of ["mCaff_Guwahati", "mCaff_Mumbai"]) {
    assert.equal(gatepassPrefix(f, APR_2026), null, `${f} must not invent a prefix`)
  }
})

test("the FY in the prefix flips on 1 April, not 1 January", () => {
  assert.equal(gatepassPrefix("mCaff_Ahmedabad", APR_2026), "M/AHM/OG/2627/")
  assert.equal(gatepassPrefix("mCaff_Ahmedabad", MAR_2026), "M/AHM/OG/2526/")
  assert.equal(canonicalGatepassCode("mCaff_Ahmedabad", 11, APR_2026), "M/AHM/OG/2627/0011")
  assert.equal(canonicalGatepassCode("HYP_AHMD", 7, APR_2026), "H/AHM/OG/2627/0007")
})

test("a counter wider than the padding keeps its digits", () => {
  assert.equal(canonicalGatepassCode("mCaff_Kolkata2", 22098, MAR_2026), "M/KOL2/OG/2526/22098")
})

test("splitting the shapes the live tenant actually carries", () => {
  assert.deepEqual(splitGatepassCode("M/AHM/OG/2627/0011"),
    { prefix: "M/AHM/OG/2627/", seq: 11, pad: 4, fyToken: "2627" })
  assert.deepEqual(splitGatepassCode("GP/MWH22396"),
    { prefix: "GP/MWH", seq: 22396, pad: 5, fyToken: null })
  assert.deepEqual(splitGatepassCode("0001"),
    { prefix: "", seq: 1, pad: 4, fyToken: null })
  assert.equal(splitGatepassCode("GM/26-27/GP/1241").fyToken, "26-27")
  assert.equal(splitGatepassCode("MLUCGP/270024").seq, 270024)
  assert.equal(splitGatepassCode("SR/H/AMD/2526/OUT/GP0014").prefix, "SR/H/AMD/2526/OUT/GP")
  // A code that is all letters has no counter at all.
  assert.equal(splitGatepassCode("NOSEQ").seq, null)
})

test("every mapped facility is one the page can actually select", () => {
  for (const f of Object.keys(CITY)) {
    assert.ok((FACILITIES as readonly string[]).includes(f),
      `${f} has a city but is not selectable — one of the two lists is wrong`)
  }
})

test("no two facilities share a gatepass series", () => {
  // A prefix is the counter Unicommerce numbers a facility's gatepasses from,
  // and each facility counts independently — so two facilities on one prefix
  // would BOTH issue `…/0001`. That duplicate is exactly what a gatepass code
  // exists to prevent, and it is what `gatepass_codes.py` flags as an "echo".
  //
  // Two collisions were live on 2026-08-28 (mCaff_Lucknow2/3 on M/LUC, and
  // HYP_DLGWHT/HYP_SRGWHT on H/GWHT) and were resolved by giving each facility
  // its own city token. This is the guard that stops a third appearing: the
  // entity letter alone does NOT separate them, because both members of each of
  // those pairs carried the same letter.
  const bySeries = new Map<string, string[]>()
  for (const f of Object.keys(CITY)) {
    const p = gatepassPrefix(f, APR_2026)!
    bySeries.set(p, [...(bySeries.get(p) ?? []), f])
  }
  const collisions = [...bySeries.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([p, fs]) => `${p} <- ${fs.sort().join(" + ")}`)
    .sort()

  assert.deepEqual(collisions, [], "each facility needs its own series")
  assert.equal(bySeries.size, Object.keys(CITY).length)
})

// ── line items: package types, i.e. boxes ───────────────────────────────────

test("a line is a package type and its quantity is boxes, not line items", () => {
  // Order 9318101 spans three export rows in one package type. That is ONE box,
  // not three — counting rows here would have been the whole bug.
  const summary = summariseRows(rows([
    HEADER,
    "9318101,DRY069,2026-08-27 08:45:46",
    "9318101,DRY069,2026-08-27 08:45:46",
    "9318101,DRY069,2026-08-27 08:45:46",
    "9318102,DRY069,2026-08-27 09:00:00",
    "9318103,DRY070,2026-08-27 09:30:00",
  ].join("\n")), "mCaff_Ahmedabad")

  assert.deepEqual(packageTypeItems(summary), [
    { code: "DRY069", quantity: 2 },
    { code: "DRY070", quantity: 1 },
  ])
})

test("an order under two package types is a box in each", () => {
  // Correct, and no longer flagged: the gatepass covers one FACILITY and carries
  // every package type, so this is simply two boxes on the same document.
  const summary = summariseRows(rows([
    HEADER, "SO1,DRY069,2026-08-27 10:00:00", "SO1,DRY070,2026-08-27 10:00:00",
  ].join("\n")), "x")
  assert.deepEqual(packageTypeItems(summary), [
    { code: "DRY069", quantity: 1 },
    { code: "DRY070", quantity: 1 },
  ])
})

test("a package type's boxes are summed across the range's days", () => {
  // The summary splits DRY069 over two dates; the gatepass is one document for
  // the window, so its line must carry both days' boxes.
  const summary = summariseRows(rows(EXPORT_2_DAYS), "x")
  assert.equal(summary.length, 3, "summary stays per (date, package type)")
  assert.deepEqual(packageTypeItems(summary), [
    { code: "DRY069", quantity: 2 },   // 1 on the 26th + 1 on the 27th
    { code: "DRY070", quantity: 1 },
  ])
})

test("nothing shipped means no lines, not a crash", () => {
  assert.deepEqual(packageTypeItems([]), [])
})

// ── the plan ────────────────────────────────────────────────────────────────

const HEADER = "Display Order Code,Shipping Package Type,Invoice Created"
const EXPORT = [
  HEADER,
  "SO1,DRY069,2026-08-27 10:00:00",
  "SO1,DRY069,2026-08-27 10:00:00",
  "SO2,DRY070,2026-08-27 11:00:00",
].join("\n")

/** The same two package types spread over two invoice dates. */
const EXPORT_2_DAYS = [
  HEADER,
  "SO1,DRY069,2026-08-26 10:00:00",
  "SO2,DRY069,2026-08-27 10:00:00",
  "SO3,DRY070,2026-08-27 11:00:00",
].join("\n")

const plan = (csv: string, facility: string, opts = {}) => {
  const r = rows(csv)
  return planFacility(r, summariseRows(r, facility), facility, { at: APR_2026, ...opts })
}

test("one gatepass per facility, one line per package type inside it", () => {
  const p = plan(EXPORT, "mCaff_Ahmedabad")
  assert.equal(p.facility, "mCaff_Ahmedabad")
  assert.equal(p.type, DEFAULT_TYPE)
  assert.equal(p.type, "NON_RETURNABLE")
  assert.equal(p.orders, 2)            // SO1 counted once despite two rows
  assert.equal(p.rows, 3)              // export rows, for context only
  assert.deepEqual(p.items, [
    { code: "DRY069", quantity: 1 },
    { code: "DRY070", quantity: 1 },
  ])
  assert.equal(p.prefix, "M/AHM/OG/2627/")
  assert.deepEqual(p.sampleOrders, ["SO1", "SO2"])
})

test("the party is per facility — one value for all is what broke Ahmedabad", () => {
  // Dry_Inv_CWH_Consumption creates at Chennai and is rejected at Ahmedabad with
  // INVALID_PARTY_CODE. A single global default cannot be right.
  assert.notEqual(toPartyFor("mCaff_Ahmedabad"), toPartyFor("Mcaff_Chennai"))
  assert.equal(toPartyFor("mCaff_Ahmedabad"), "Dry_Inventory_")

  // A facility with no known party resolves to null and is refused, never
  // defaulted to somebody else's party.
  for (const f of ["mCaff_Mumbai", "HYP_SPCHN", "Mcaff_Nagpur", "HYP_DLGWHT"]) {
    assert.equal(toPartyFor(f), null, `${f} must not borrow another site's party`)
  }
  assert.equal(toPartyFor("NOT_A_FACILITY"), null)
})

test("every configured party belongs to a selectable facility", () => {
  for (const f of Object.keys(TO_PARTY)) {
    assert.ok((FACILITIES as readonly string[]).includes(f), `${f} is not selectable`)
  }
})

test("an empty toParty is still refused rather than sent blank", () => {
  // Unreachable through toPartyFor today, but this is the invariant that matters:
  // toParty is printed on the document, so a blank one must never go out.
  assert.equal(plan(EXPORT, "mCaff_Ahmedabad", { toParty: "   " }).toParty, null)
  assert.equal(plan(EXPORT, "mCaff_Ahmedabad").toParty, null)
})

// ── the refusals ────────────────────────────────────────────────────────────

test("a fully-specified plan is NOT blocked", () => {
  // Real toParty, real prefix, real box counts, verified payload — nothing left
  // to refuse on, so creating is allowed. There used to be an unconditional
  // blocker here while the payload was unverified; it was removed deliberately
  // on 2026-08-28 once the contract and the addItem endpoint were both known.
  //
  // Every remaining blocker is knowable WITHOUT sending anything, which is the
  // rule for what belongs in this list at all.
  const good = plan(EXPORT, "mCaff_Ahmedabad", { toParty: toPartyFor("mCaff_Ahmedabad") })
  assert.deepEqual(blockers([good]), [])
})

test("each fixable blocker names the facility it is about", () => {
  const noParty = plan(EXPORT, "mCaff_Ahmedabad")
  assert.ok(blockers([noParty]).some((b) => /toParty.*mCaff_Ahmedabad/.test(b)))

  const nothingShipped = plan(HEADER, "mCaff_Ahmedabad", { toParty: toPartyFor("mCaff_Ahmedabad") })
  assert.ok(blockers([nothingShipped]).some((b) => /No package types.*mCaff_Ahmedabad/.test(b)))

  const noPrefix = plan(EXPORT, "mCaff_Mumbai", { toParty: toPartyFor("mCaff_Ahmedabad") })
  assert.ok(blockers([noPrefix]).some((b) => /No code prefix.*mCaff_Mumbai/.test(b)))
})

test("an empty plan refuses with something to say", () => {
  assert.ok(blockers([]).some((b) => /nothing to create/.test(b)))
})

test("the payload is the real create schema, and carries no quantities", () => {
  const p = { ...plan(EXPORT, "mCaff_Ahmedabad", { toParty: toPartyFor("mCaff_Ahmedabad") }), window: "2026-08-26" }
  const code = dryGatepassCode("mCaff_Ahmedabad", 1, APR_2026)!
  const body = buildGatepassPayload(p, code) as {
    type: string; partyCode: string
    wsGatePass: Record<string, unknown>
  }

  // Three top-level keys. There is NO `gatepass` wrapper — the API rejects one.
  assert.deepEqual(Object.keys(body).sort(), ["partyCode", "type", "wsGatePass"])
  assert.equal(body.type, "NON_RETURNABLE")
  assert.equal(body.partyCode, "Dry_Inventory_")

  // The code is ours, in this automation's own series, starting at 0001.
  assert.equal(body.wsGatePass.code, "M/AHM/DRY/OG/2627/0001")
  assert.equal(body.wsGatePass.referenceNumber, "Dry Consumption Till 26 Aug")

  // The create is EMPTY. Quantities belong to addItem, and duplicating them here
  // as customFieldValues would be one number in two places that can disagree.
  assert.deepEqual(Object.keys(body.wsGatePass).sort(), ["code", "referenceNumber"])
  assert.equal(JSON.stringify(body).includes("DRY069"), false)
})

test("the reference reads the way the desk writes it by hand", () => {
  // The live M/AHM/OG/2627/0012 carries exactly this wording, so an automated
  // gatepass sits on the shelf reading like a manual one rather than announcing
  // itself with an ISO date.
  assert.equal(gatepassReference("2026-08-26"), "Dry Consumption Till 26 Aug")
  // Single-digit days are not zero-padded — "5 Aug", the way it is written.
  assert.equal(gatepassReference("2026-08-05"), "Dry Consumption Till 5 Aug")
  assert.equal(gatepassReference("2026-01-01"), "Dry Consumption Till 1 Jan")
  assert.equal(gatepassReference("2026-12-31"), "Dry Consumption Till 31 Dec")

  // Blank rather than "Invalid Date": an empty reference is recoverable, a
  // printed NaN on a warehouse document is not.
  assert.equal(gatepassReference(undefined), "")
  assert.equal(gatepassReference("not-a-date"), "")
})

test("omitting the code hands numbering back to Uniware", () => {
  // How M/AHM/OG/2627/0013 happened: no code sent, so Uniware used the facility's
  // hand-raised series. Passing null must stay possible, and stay deliberate.
  const p = plan(EXPORT, "mCaff_Ahmedabad", { toParty: toPartyFor("mCaff_Ahmedabad") })
  const body = buildGatepassPayload(p, null) as { wsGatePass: { code: string | null } }
  assert.equal(body.wsGatePass.code, null)
})

// -- the DRY series -------------------------------------------------------

test("the DRY series is separate from the hand-raised one", () => {
  assert.equal(dryGatepassPrefix("mCaff_Ahmedabad", APR_2026), "M/AHM/DRY/OG/2627/")
  assert.equal(gatepassPrefix("mCaff_Ahmedabad", APR_2026), "M/AHM/OG/2627/")
  assert.notEqual(
    dryGatepassPrefix("mCaff_Ahmedabad", APR_2026),
    gatepassPrefix("mCaff_Ahmedabad", APR_2026),
    "a shared prefix would mean one counter, and the automation could reuse a printed number",
  )
  assert.equal(dryGatepassCode("mCaff_Ahmedabad", 1, APR_2026), "M/AHM/DRY/OG/2627/0001")
  assert.equal(dryGatepassCode("mCaff_Mumbai", 1, APR_2026), null)   // unmapped, never guessed
})

test("a brand-new series starts at 0001", () => {
  const prefix = dryGatepassPrefix("mCaff_Ahmedabad", APR_2026)!
  assert.equal(nextSerialFrom([], prefix), 1)
  // The facility's HAND-RAISED codes must not advance the automation's counter.
  assert.equal(nextSerialFrom(
    ["M/AHM/OG/2627/0011", "M/AHM/OG/2627/0012", "M/AHM/OG/2627/0013"], prefix), 1)
})

test("the next serial is max + 1, so a cancelled gatepass never gets reused", () => {
  const prefix = dryGatepassPrefix("mCaff_Ahmedabad", APR_2026)!
  // 0002 cancelled and gone: counting rows would return 3 and re-issue 0003,
  // which 0003 already used. Taking the max returns 4.
  assert.equal(nextSerialFrom([
    `${prefix}0001`, `${prefix}0003`,
  ], prefix), 4)
  // Another facility's DRY codes are a different series and are ignored.
  assert.equal(nextSerialFrom([`${prefix}0007`, "H/AHM/DRY/OG/2627/0099"], prefix), 8)
})
