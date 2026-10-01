// matchSkuDetailed: our code first, then name and filling matched separately. Fixtures are
// real printed lines from prod invoice_items_mfg and the SKU the desk booked them as.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanName, matchSkuDetailed, parseFilling } from "../../lib/invoice/invoice-mapping"
import type { SkuOption } from "../../app/po-tracking/po-procurement/po-types"

const sku = (id: number, sku_code: string, name: string, filling: number | null): SkuOption =>
  ({ id, sku_code, name, status: "active", entity_code: "PEP", filling })

const SKUS: SkuOption[] = [
  sku(1, "Mcaf401", "By The Blues Perfume Body Lotion", 300),
  sku(2, "MCFMUWB0401F0015", "By The Blues Perfume Body Lotion 15ml", 15),
  sku(3, "200MCaf401_WB", "By The Blues Perfume Body Lotion 200ml Without Box", 200),
  sku(4, "MCFMUWB0401F0600", "By The Blues Perfume Body Lotion 600ml", 600),
  sku(5, "MCFMUWB0401F0080", "By The Blues Perfume Body Lotion 80ml", 82),
  sku(6, "MCaf383_WB", "Brightening Raspberry Rush Body Wash", 310),
  sku(7, "MCaf383_WB_N1", "Brightening Raspberry Rush Body Wash", 300),
  sku(8, "MCaf396", "Guava Tini De-Tan Body Wash", 300),
  sku(9, "Mcaf396_WB", "Guava Tini De-Tan Body Wash", 300),
  sku(10, "MCaf352", "Magnetic", 100),
  sku(11, "20MCaf352", "Magnetic", 352),
  sku(12, "MCFMUBX0352F0050", "Magnetic", 50),
  sku(13, "HYPMUBX0046F0030", "Dual-Phase Advanced De-Pigmentation Serum 30ml", 30),
  sku(14, "50SMCaf40", "Naked & Raw coffee body Scrub(50gm)", 50),
  sku(15, "600MCaf370", "Sweet Escape Perfume Body Lotion", 590),
  sku(16, "MCaf370", "Sweet Escape Perfume Body Lotion", 295),
]
const ctx = { allSkus: SKUS }
const pick = (name: string, code: string | null = null, extra = {}) =>
  matchSkuDetailed({ code, name }, { ...ctx, ...extra }).sku?.sku_code ?? null

test("the size picks the pack, not string similarity", () => {
  assert.equal(pick("By The Blues Perfume body lotion 300 ml"), "Mcaf401")
  assert.equal(pick("By The Blues Perfume body lotion 600 ml"), "MCFMUWB0401F0600")
  assert.equal(pick("MCAFFEINE BY THE BLUES PERFUME BODYLOTION 1X80ML PO No : MPO-OO113461-2"), "MCFMUWB0401F0080")
  assert.equal(pick("Sweet Escape Perfume Body Lotion 600ml"), "600MCaf370")
})

test("our sku_code wins wherever it is printed; a supplier's own code is ignored", () => {
  assert.equal(pick("MCaf401- By The Blue Body Lotion 300ml"), "Mcaf401")
  assert.equal(pick("By The Blues Perfume body lotion 600 ml", "mcaf401"), "Mcaf401")
  assert.equal(pick("MCAFFEINE BY THE BLUES PERFUME BODYLOTION 1X80ML", "FG002500"), "MCFMUWB0401F0080")
})

test("nearest fill within 10% breaks a same-name pair", () => {
  // 310 vs 300 for a printed 300: both within tolerance, the exact one wins.
  assert.equal(pick("MCAFFINE BRIGHTENING RASPBERRY RUSH BODYWASH (NEW PM) 300ML"), "MCaf383_WB_N1")
  // Missing leading word still lands through containment.
  assert.equal(pick("Raspberry Rush Body Wash 300 ml"), "MCaf383_WB_N1")
})

test("a true tie stays blank with its look-alikes, unless history decides", () => {
  const m = matchSkuDetailed({ name: "Guava Tini DE-TAN Body Wash 300ML" }, ctx)
  assert.equal(m.sku, null)
  assert.deepEqual(m.candidates.map((c) => c.sku_code).sort(), ["MCaf396", "Mcaf396_WB"])
  const history = [{ sku_name: "Guava Tini DE-TAN Body Wash 300ML", sku_code: "Mcaf396_WB", n: 2 }]
  assert.equal(pick("Guava Tini DE-TAN Body Wash 300ML", null, { history }), "Mcaf396_WB")
})

test("a size outside tolerance is no match, not the nearest wrong pack", () => {
  assert.equal(pick("Magnetic 20ml"), null)
})

test("noise and punctuation don't stop an exact name", () => {
  assert.equal(pick("HYPHEN DUAL PHASE ADVANCED DEPIGMENTATION SERUM"), "HYPMUBX0046F0030")
  assert.equal(pick("Naked and Raw Coffee Body Scrub 50 g"), "50SMCaf40")
})

test("the manufacturer's SKUs are searched first", () => {
  const m = matchSkuDetailed({ name: "Magnetic" }, { ...ctx, mfgSkuCodes: ["MCaf352"] })
  assert.equal(m.sku?.sku_code, "MCaf352")
})

test("parseFilling and cleanName", () => {
  assert.equal(parseFilling("Body Lotion 1X80ML"), 80)
  assert.equal(parseFilling("Hair Oil 1 L"), 1000)
  assert.equal(parseFilling("Guava Tini De- Tan Face Scrub 100"), 100)
  assert.equal(parseFilling("Sunscreen SPF 50"), null)
  assert.equal(parseFilling("FG-MCAFFEINE-PER-100ML-FEIN-MAGNETIC X 24"), 100)
  assert.equal(cleanName("MCAFFEINE By The Blues  Perfume Body-Lotion 300 ml"), "bythebluesperfumebodylotion")
})
