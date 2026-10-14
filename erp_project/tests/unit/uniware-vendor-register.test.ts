// Register's two pure halves: spotting a vendor Uniware already has, and the create payload.
import { test } from "node:test"
import assert from "node:assert/strict"
import { matchVendor, normalizeVendorName, soleExactMatch } from "../../lib/uniware/vendor-match"
import { buildVendorCreatePayload, vendorAddressFor, VENDOR_ADDRESSES, VENDOR_PHONE, VENDOR_EMAIL } from "../../lib/uniware/vendor-registry"

const NG = { code: "MFG-005-NGE", name: "NG Electro", registered_name: "N.G. Electro Products Pvt. Ltd." }

test("normalizeVendorName drops punctuation, case and company suffixes", () => {
  assert.equal(normalizeVendorName("N.G. Electro Products Pvt. Ltd."), "ngelectroproducts")
  assert.equal(normalizeVendorName("N_G_Electro_Products_Pvt_Ltd_"), "ngelectroproducts")
  assert.equal(normalizeVendorName("_Reve_"), "reve")
})

test("finds the hand-typed codes NG Electro actually has in Uniware", () => {
  for (const code of ["NG_ELECTRO", "NG_Electro", "N_G_Electro_Products_Pvt_Ltd", "MFG-005-NGE"]) {
    assert.deepEqual(matchVendor([{ code, name: code }], NG).map((v) => v.code), [code], code)
  }
  // Matched by Uniware's vendor NAME when the code is opaque.
  assert.equal(matchVendor([{ code: "V0042", name: "N.G. Electro Products Pvt. Ltd." }], NG).length, 1)
})

test("HYP_DLGWHT's real vendor list has no NG Electro, and no false hit", () => {
  const dlgwht = [
    { code: "HYP_Guwahati1_", name: "HYP_Guwahati1_" }, { code: "GGN_Motherwarehouse", name: "GGN_Motherwarehouse" },
    { code: "Cheryl", name: "CHERYL LABORATORIES PRIVATE LIMITED" }, { code: "DCG", name: "DCG Tech Limited" },
    { code: "MOGLILABS", name: "Mogli Labs (India) Pvt Ltd" }, { code: "ANANYA", name: "Ananya Herbal Pvt. Ltd." },
    { code: "HYP_B2B_GGN_", name: "HYP_B2B_GGN_" }, { code: "AROVEA", name: "Arovea Formulations Private Limited" },
    { code: "SAMRVIR", name: "SAMRVIR BIOTECH PVT. LTD." },
  ]
  assert.deepEqual(matchVendor(dlgwht, NG), [])
  assert.deepEqual(matchVendor(dlgwht, { code: "MFG-012-ANA", name: "Ananya", registered_name: "Ananya Herbal Pvt. Ltd." }).map((v) => v.code), ["ANANYA"])
  assert.deepEqual(matchVendor(dlgwht, { code: "MFG-001-CHE", name: "Cheryl", registered_name: "Cheryl Laboratories Private Limited" }).map((v) => v.code), ["Cheryl"])
})

test("several matching vendors come back for the user to pick, deduped by code", () => {
  const two = [
    { code: "REVE", name: "REVE PHARMA" }, { code: "Reve_Pharma", name: "Reve Pharma" }, { code: "REVE", name: "REVE" },
  ]
  const m = matchVendor(two, { code: "MFG-014-REV", name: "Reve", registered_name: "Reve Pharma" })
  assert.deepEqual(m.map((v) => v.code).sort(), ["REVE", "Reve_Pharma"])
})

test("the sweep's three misses are now caught — as loose hits, so the user confirms", () => {
  const cases: [string, { code: string; name: string; registered_name: string }][] = [
    ["All_Mask_Hyphen", { code: "MFG-011-ALL", name: "All Mask", registered_name: "Jainam Invamed Pvt Ltd" }],
    ["Yasharth_Wellness", { code: "MFG-009-YAS", name: "Yasharth", registered_name: "Yasharth Wellness Solutions Private Limited" }],
    ["REVE_PHARMA_Hyphen", { code: "MFG-014-REV", name: "Reve", registered_name: "Reve Pharma" }],
  ]
  for (const [code, mfg] of cases) {
    const m = matchVendor([{ code, name: code }], mfg)
    assert.deepEqual(m.map((v) => v.code), [code], code)
    assert.equal(m[0].exact, false, code)
    assert.equal(soleExactMatch(m), null, code) // never auto-picked
  }
})

test("short names only match exactly — no 'reve' in revenue or Product_Review", () => {
  const reve = { code: "MFG-014-REV", name: "Reve", registered_name: "Reve Pharma" }
  assert.deepEqual(matchVendor([{ code: "Revenue_Traders", name: "Revenue Traders" }, { code: "Product_Review_MMEnt", name: "Product_Review_MMEnt" }], reve), [])
  assert.equal(soleExactMatch(matchVendor([{ code: "REVE", name: "REVE" }], reve))?.code, "REVE")
})

test("an exact hit beside a loose one still goes to the user", () => {
  const m = matchVendor([{ code: "KainCosmeceuticals_01", name: "Kain Cosmeceuticals" }, { code: "Kain_Cosmeceuticals_Raigad", name: "x" }],
    { code: "MFG-010-KAI", name: "Kain", registered_name: "Kain Cosmeceuticals Pvt. Ltd." })
  assert.equal(m.length, 2)
  assert.equal(soleExactMatch(m), null)
})

test("the create payload carries only what V2 asked for, ship-to = bill-to", () => {
  const addr = vendorAddressFor("02aaccn5184h1zm")
  assert.ok(addr)
  const p = buildVendorCreatePayload({ code: "MFG-005-NGE", name: "N.G. Electro Products Pvt. Ltd." }, addr)
  assert.deepEqual(Object.keys(p.vendor).sort(), ["billingAddress", "code", "name", "partyContacts", "shippingAddress"])
  assert.deepEqual(p.vendor.shippingAddress, p.vendor.billingAddress)
  assert.equal(p.vendor.billingAddress.pincode, "173205")
  assert.equal(p.vendor.billingAddress.phone, VENDOR_PHONE)
  assert.deepEqual(p.vendor.partyContacts, [{ contactType: "PRIMARY", name: "N.G. Electro Products Pvt. Ltd.", email: VENDOR_EMAIL, phone: VENDOR_PHONE }])
})

test("every registry address is complete, with a 6-digit PIN and a 2-letter state", () => {
  for (const [gstin, a] of Object.entries(VENDOR_ADDRESSES)) {
    assert.match(gstin, /^\d{2}[A-Z0-9]{13}$/, gstin)
    assert.ok(a.addressLine1 && a.city, gstin)
    assert.match(a.pincode, /^\d{6}$/, gstin)
    assert.match(a.stateCode, /^[A-Z]{2}$/, gstin)
  }
  assert.equal(Object.keys(VENDOR_ADDRESSES).length, 14)
  assert.equal(vendorAddressFor("02AAACK2660H1Z0"), null) // Kapco — no PIN yet
})

test("a code over Uniware's 45 chars is refused before any call", () => {
  assert.throws(() => buildVendorCreatePayload({ code: "X".repeat(46), name: "n" }, Object.values(VENDOR_ADDRESSES)[0]))
})
