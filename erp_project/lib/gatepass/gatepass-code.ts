/**
 * Gatepass code grammar: `<entity>/<city>/OG/<fy>/<nnnn>` — e.g. M/AHM/OG/2627/0011.
 */

import { financialYearToken } from "@/lib/uniware/po-code"

/** Outward gatepass. The only document kind this covers. */
export const DOC = "OG"

/** Zero-padding of the counter. A longer counter is not truncated — see `padSerial`. */
export const PAD = 4

export const CITY: Record<string, string> = {
  // MUM_WAREHOUSE2: "MUM",
  // GGN_WAREHOUSE: "GGN",
  mCaff_Ahmedabad: "AHM",
  mCaff_Bangalore2: "BLR2",
  mCaff_Guwahati2: "GWHT2",
  mCaff_Hyderabad2: "HYD2",
  mCaff_Kolkata2: "KOL2",
  mCaff_Lucknow3: "LUC3",
  Mcaff_Nagpur: "NAG",
  HYP_AHMD: "AHM",
  HYP_SRBGLR: "SRBLR",
  HYP_DLGWHT: "DLGWHT",
  HYP_SRHYD: "SRHYD",
  HYP_SRKOL: "SRKOL",
  HYP_SRLOK2: "SRLUC2",
  HYP_DLNAG: "DLNAG",
  HYP_SPCHN : "SRCHN",
  HYP_SRGWHT : "SRGWHT",
  Mcaff_Chennai : "CHN",
  mCaff_Lucknow2 :"LUC2",
  // HYP_B2B_MUM2: "MUM",
  // HYP_B2B_GGN: "GGN",
}

/**
 * `HYP_*` is Hyphen, everything else is mCaffeine. B2B is NOT a separate entity.
 *
 * Derived from the facility code rather than read from `master_entity.code`,
 * because this feature has no DB behind it. `poLetterForEntity` in
 * lib/constants.ts is the same M/H split keyed on PEP/KREATIVE — if this screen
 * ever gains a DB read, that is the function to defer to, not this one.
 */
export function entityLetter(facility: string): "M" | "H" {
  return facility.trim().toUpperCase().startsWith("HYP") ? "H" : "M"
}

/** `<entity>/<city>`, e.g. H/MUM for HYP_B2B_MUM2 against M/MUM for MUM_WAREHOUSE2. */
export function site(facility: string): string | null {
  const city = CITY[facility]
  return city ? `${entityLetter(facility)}/${city}` : null
}

/**
 * The prefix a facility's gatepasses should carry, e.g. `M/AHM/OG/2627/`.
 *
 * Null for an unmapped facility. `financialYearToken` is reused from
 * lib/uniware/po-code.ts — it is the same April-to-March rule as the script's
 * `indian_fy` (April 2026 → "2627") and already has its boundary pinned by
 * tests/unit/uniware-po-code.test.ts.
 */
export function gatepassPrefix(facility: string, at: Date = new Date()): string | null {
  const where = site(facility)
  return where ? `${where}/${DOC}/${financialYearToken(at)}/` : null
}

/** Serial padded to PAD, and never truncated — a counter wider than PAD keeps its digits. */
export function padSerial(seq: number, pad = PAD): string {
  return String(Math.trunc(seq)).padStart(pad, "0")
}

/** The full canonical code, when a serial is known. Nothing in this feature mints one. */
export function canonicalGatepassCode(
  facility: string, seq: number, at: Date = new Date(), pad = PAD,
): string | null {
  const prefix = gatepassPrefix(facility, at)
  return prefix ? `${prefix}${padSerial(seq, pad)}` : null
}

/**
 * Split an EXISTING code into its two real parts: a free-text prefix and a
 * zero-padded counter. Nothing else is assumed — the live tenant carries
 * `M/AHM/OG/2627/0011`, `GP/MWH22396`, `0001` and `MLUCGP/270024` side by side.
 *
 * A four-digit year token counts only when it sits in the PREFIX; the counter
 * itself is never read as a year.
 */
export function splitGatepassCode(code: string): {
  prefix: string; seq: number | null; pad: number; fyToken: string | null
} {
  const m = /^(.*?)(\d+)$/.exec(String(code).trim())
  if (!m) return { prefix: String(code), seq: null, pad: 0, fyToken: null }
  const [, prefix, digits] = m
  const token = /(?<!\d)(\d{4}|\d{2}-\d{2})(?!\d)/.exec(prefix)
  return { prefix, seq: Number(digits), pad: digits.length, fyToken: token ? token[1] : null }
}

/**
 * The segment marking the series this automation raises into.
 *
 * `M/AHM/DRY/OG/2627/0001` against the hand-raised `M/AHM/OG/2627/0013`.
 * It sits after the site and before the document type, so a code still reads
 * left-to-right as "whose / where / which stream / what / when / which one".
 *
 * The point is a SEPARATE COUNTER. A distinct prefix is its own series in
 * Unicommerce, so this stream starts at 0001 and never interleaves with the
 * numbers people raise by hand — which is what makes "did a human or the ERP
 * raise this?" answerable from the code alone, and what stops the two ever
 * racing to the same number.
 *
 * One constant to change if the segment or its position moves.
 */
export const DRY = "DRY"

/** This automation's series for a facility, e.g. `M/AHM/DRY/OG/2627/`. */
export function dryGatepassPrefix(facility: string, at: Date = new Date()): string | null {
  const where = site(facility)
  return where ? `${where}/${DRY}/${DOC}/${financialYearToken(at)}/` : null
}

/** This automation's full code for a known serial. */
export function dryGatepassCode(
  facility: string, seq: number, at: Date = new Date(), pad = PAD,
): string | null {
  const prefix = dryGatepassPrefix(facility, at)
  return prefix ? `${prefix}${padSerial(seq, pad)}` : null
}

/**
 * The next serial in a series, given every code that already exists in it.
 *
 * **Starts at 1 when the series is empty** — a brand-new `…/DRY/…` prefix has no
 * history, which is exactly the "start from 0001" case.
 *
 * Only codes carrying THIS prefix count. A facility's hand-raised series
 * (`M/AHM/OG/2627/0013`) and this one (`M/AHM/DRY/OG/2627/…`) are different
 * counters, and mixing them would make the automation inherit a number people
 * had already used.
 *
 * `max + 1`, not `count + 1`: a cancelled or deleted gatepass leaves a hole, and
 * counting rows would then re-issue a number that has already been printed.
 */
export function nextSerialFrom(codes: string[], prefix: string): number {
  let highest = 0
  for (const code of codes) {
    if (!code.startsWith(prefix)) continue
    const { seq } = splitGatepassCode(code)
    if (seq !== null && seq > highest) highest = seq
  }
  return highest + 1
}

/**
 * Midnight on 1 April of the financial year `at` falls in.
 *
 * The window a serial lookup has to cover: a series is per FY, so every code in
 * the current one was created on or after this instant. Searching from later
 * would miss earlier codes and re-issue a number.
 */
export function financialYearStart(at: Date = new Date()): Date {
  const y = at.getUTCFullYear()
  const startYear = at.getUTCMonth() + 1 >= 4 ? y : y - 1
  return new Date(Date.UTC(startYear, 3, 1))
}
