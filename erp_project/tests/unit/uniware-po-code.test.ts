import test from "node:test"
import assert from "node:assert/strict"
import {
  financialYearToken, poPrefix, buildUniwarePoCode, poCodePartsFor, SERIAL_WIDTH,
} from "../../lib/uniware/po-code"
import { poLetterForEntity } from "../../lib/constants"

// The FY boundary is the whole reason this is computed in IST. A UTC-derived year
// files an 01-Apr-00:30-IST PO in the PREVIOUS financial year, and it reads
// correctly on a laptop in India and wrongly in the UTC container.
test("financialYearToken uses the IST boundary, not UTC", () => {
  // 31 Mar 2026 23:30 IST == 18:00 UTC. Still FY 2025-26.
  assert.equal(financialYearToken(new Date("2026-03-31T18:00:00Z")), "2526")
  // 01 Apr 2026 00:30 IST == 31 Mar 2026 19:00 UTC. Already FY 2026-27 — this is
  // the case a UTC year gets wrong.
  assert.equal(financialYearToken(new Date("2026-03-31T19:00:00Z")), "2627")
  assert.equal(financialYearToken(new Date("2026-08-26T12:00:00Z")), "2627")
  // Jan-Mar belongs to the year before.
  assert.equal(financialYearToken(new Date("2027-01-15T12:00:00Z")), "2627")
  assert.equal(financialYearToken(new Date("2027-04-15T12:00:00Z")), "2728")
})

test("prefix and code are built from the same string", () => {
  const parts = { letter: "M", shortCode: "MUM1", fy: "2627" }
  assert.equal(poPrefix(parts), "M/MUM1/2627")
  assert.equal(buildUniwarePoCode(parts, 1234), "M/MUM1/2627/01234")
  // The prefix the allocator probes on must be a prefix of what gets written, or
  // it reads a different series from the one it writes into.
  assert.ok(buildUniwarePoCode(parts, 1).startsWith(poPrefix(parts) + "/"))
})

test("serial padding grows rather than truncating", () => {
  const parts = { letter: "H", shortCode: "GGN1", fy: "2627" }
  assert.equal(buildUniwarePoCode(parts, 1), "H/GGN1/2627/00001")
  assert.equal(buildUniwarePoCode(parts, 99999), "H/GGN1/2627/99999")
  // Past the width the segment must LENGTHEN. Truncating would collide with a
  // number already used.
  assert.equal(buildUniwarePoCode(parts, 100000), "H/GGN1/2627/100000")
  assert.equal(String(1).padStart(SERIAL_WIDTH, "0").length, SERIAL_WIDTH)
})

test("entity letters match the live tenant", () => {
  assert.equal(poLetterForEntity("PEP"), "M")
  assert.equal(poLetterForEntity("KREATIVE"), "H")
  assert.equal(poLetterForEntity("kreative"), "H")   // case-insensitive
  // Never guess: an unmapped entity mints nothing rather than a plausible code
  // in the wrong series.
  assert.equal(poLetterForEntity("ACME"), null)
  assert.equal(poLetterForEntity(null), null)
})

test("an unconfigured facility yields no parts, which is not an error", () => {
  const at = new Date("2026-08-26T12:00:00Z")
  // No short code -> Uniware numbers the PO, exactly as today.
  assert.equal(poCodePartsFor({ po_short_code: null, entity_code: "PEP" }, poLetterForEntity, at), null)
  assert.equal(poCodePartsFor({ po_short_code: "  ", entity_code: "PEP" }, poLetterForEntity, at), null)
  // Unmapped entity is equally "not configured", never a guessed letter.
  assert.equal(poCodePartsFor({ po_short_code: "MUM1", entity_code: "ACME" }, poLetterForEntity, at), null)

  assert.deepEqual(
    poCodePartsFor({ po_short_code: " mum1 ", entity_code: "PEP" }, poLetterForEntity, at),
    { letter: "M", shortCode: "MUM1", fy: "2627" }
  )
})
