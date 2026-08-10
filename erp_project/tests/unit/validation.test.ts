// The Zod schemas are the only thing standing between a request body and the
// database. These tests cover the rules a UI change could quietly drop:
// mandatory edit remarks (the audit trail depends on them) and the PO
// quantity/receipt guards.
import { test } from "node:test"
import assert from "node:assert/strict"
import { skuUpdateSchema } from "../../lib/validation/skus"
import { vendorUpdateSchema } from "../../lib/validation/vendors"
import { mfgUpdateSchema } from "../../lib/validation/manufacturers"
import { materialMasterUpdateSchema } from "../../lib/validation/material-master"
import { poSplitSchema, poReceiveSchema, poIdParamSchema } from "../../lib/validation/purchase-order-detail"

type ParseResult = { success: boolean; error?: { issues: { path: (string | number | symbol)[]; message: string }[] } }

/** True when the parse failed specifically because of `field`. */
function failedOn(result: ParseResult, field: string): boolean {
  return !result.success && (result.error?.issues ?? []).some(i => i.path.join(".") === field)
}

/** Same payload minus one key — for asserting a field is genuinely required. */
function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj }
  delete copy[key]
  return copy
}

// Minimal payloads that DO satisfy each schema. Field names are deliberately
// spelled out — they are not uniform across masters (`id` for SKU and material
// master, but `vendor_id` / `mfg_id` for the other two), and a test that guesses
// wrong reports a schema bug that isn't there.
const VALID_SKU = { action: "update" as const, id: 1, status: "active", remarks: "price correction" }
const VALID_VENDOR = { action: "update" as const, vendor_id: 1, name: "Acme", type: "rm", remarks: "gst updated" }
const VALID_MFG = { action: "update" as const, mfg_id: 1, name: "Plant A", remarks: "address change" }
const VALID_MM_RM = { material: "rm" as const, id: 1, name: "Glycerin", make: "ABC", inci_name: "Glycerin", remarks: "reclassified" }

// ── Mandatory remarks on every master edit ──────────────────────────────────
// Every one of these archives `remarks` into history_masters_edits, and the
// approval card shows it to the approver. A blank one makes the audit trail
// useless, so the schema — not the dialog — has to be the gate.

test("SKU update requires non-blank remarks", () => {
  assert.equal(skuUpdateSchema.safeParse(VALID_SKU).success, true, "the valid payload must parse")
  assert.ok(failedOn(skuUpdateSchema.safeParse(without(VALID_SKU, "remarks")), "remarks"), "missing remarks")
  assert.ok(failedOn(skuUpdateSchema.safeParse({ ...VALID_SKU, remarks: "" }), "remarks"), "empty remarks")
  assert.ok(failedOn(skuUpdateSchema.safeParse({ ...VALID_SKU, remarks: "   " }), "remarks"), "whitespace-only remarks")
})

test("remarks are trimmed, so '  typo fix  ' is stored as 'typo fix'", () => {
  const parsed = skuUpdateSchema.safeParse({ ...VALID_SKU, remarks: "  typo fix  " })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success && parsed.data.remarks, "typo fix")
})

test("vendor update requires non-blank remarks", () => {
  assert.equal(vendorUpdateSchema.safeParse(VALID_VENDOR).success, true)
  assert.ok(failedOn(vendorUpdateSchema.safeParse(without(VALID_VENDOR, "remarks")), "remarks"))
  assert.ok(failedOn(vendorUpdateSchema.safeParse({ ...VALID_VENDOR, remarks: " " }), "remarks"))
})

test("manufacturer update requires non-blank remarks", () => {
  assert.equal(mfgUpdateSchema.safeParse(VALID_MFG).success, true)
  assert.ok(failedOn(mfgUpdateSchema.safeParse(without(VALID_MFG, "remarks")), "remarks"))
  assert.ok(failedOn(mfgUpdateSchema.safeParse({ ...VALID_MFG, remarks: " " }), "remarks"))
})

test("material-master update requires remarks on the rm branch", () => {
  assert.equal(materialMasterUpdateSchema.safeParse(VALID_MM_RM).success, true)
  assert.ok(failedOn(materialMasterUpdateSchema.safeParse(without(VALID_MM_RM, "remarks")), "remarks"))
  assert.ok(failedOn(materialMasterUpdateSchema.safeParse({ ...VALID_MM_RM, remarks: "" }), "remarks"))
})

test("material-master update requires remarks on the pm branch too", () => {
  // A discriminated union on `material` — easy to add a rule to one arm only.
  // The pm arm requires `type` (the rm arm treats it as optional) — the two arms
  // are genuinely not symmetric, which is why both get their own test.
  const validPm = { material: "pm" as const, id: 1, name: "Bottle 200ml", type: "bottle", remarks: "vendor change" }
  assert.equal(materialMasterUpdateSchema.safeParse(validPm).success, true)
  assert.ok(failedOn(materialMasterUpdateSchema.safeParse(without(validPm, "remarks")), "remarks"))
})

test("material-master rejects an unknown material discriminator", () => {
  assert.equal(
    materialMasterUpdateSchema.safeParse({ ...VALID_MM_RM, material: "fg" }).success,
    false
  )
})

// ── PO quantity guards ──────────────────────────────────────────────────────

test("a receipt quantity must be positive", () => {
  assert.equal(poReceiveSchema.safeParse({ qty: 5 }).success, true)
  assert.equal(poReceiveSchema.safeParse({ qty: 0 }).success, false, "zero receipt is meaningless")
  assert.equal(poReceiveSchema.safeParse({ qty: -5 }).success, false, "a negative receipt would DECREMENT stock")
})

test("a receipt quantity is coerced from the string a form sends", () => {
  const parsed = poReceiveSchema.safeParse({ qty: "12" })
  assert.equal(parsed.success, true)
  assert.equal(parsed.success && parsed.data.qty, 12)
  assert.equal(typeof (parsed.success && parsed.data.qty), "number")
})

test("a non-numeric receipt quantity is rejected, not coerced to NaN", () => {
  // z.coerce.number() on "abc" yields NaN; the positive() check must catch it.
  assert.equal(poReceiveSchema.safeParse({ qty: "abc" }).success, false)
  assert.equal(poReceiveSchema.safeParse({ qty: "" }).success, false)
})

test("a split must contain at least one row", () => {
  assert.equal(poSplitSchema.safeParse({ splits: [] }).success, false)
  assert.equal(poSplitSchema.safeParse({}).success, false)
})

test("a split row rejects a non-positive quantity", () => {
  const row = (qty: unknown) => ({ splits: [{ mfg_id: 1, qty, destination: "Guwahati" }] })
  assert.equal(poSplitSchema.safeParse(row(10)).success, true)
  assert.equal(poSplitSchema.safeParse(row(0)).success, false)
  assert.equal(poSplitSchema.safeParse(row(-10)).success, false, "a negative split would ADD qty to the parent")
})

test("a PO id param must be a positive integer", () => {
  assert.equal(poIdParamSchema.safeParse({ id: "42" }).success, true)
  assert.equal(poIdParamSchema.safeParse({ id: "0" }).success, false)
  assert.equal(poIdParamSchema.safeParse({ id: "-1" }).success, false)
  assert.equal(poIdParamSchema.safeParse({ id: "abc" }).success, false)
  assert.equal(poIdParamSchema.safeParse({ id: "1; DROP TABLE" }).success, false)
})
