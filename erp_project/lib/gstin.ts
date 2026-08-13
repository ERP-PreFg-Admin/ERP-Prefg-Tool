/**
 * GSTIN structure, and which registrations are our own.
 *
 * Split out of invoice-detect.ts so it can be unit-tested without credentials —
 * that module imports ./db, which builds a connection pool at load. Nothing here
 * imports anything.
 *
 * A GSTIN is <2-digit state><10-char PAN><entity digit>Z<checksum>.
 */

/** 2-digit state code, 5-letter PAN prefix, 4 digits, PAN check letter, entity
 *  number, a literal Z, then a checksum character. */
const GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g

/** Every distinct GSTIN in a block of text, in the order it appears. */
export function findGstins(text: string): string[] {
  return [...new Set(text.match(GSTIN_PATTERN) ?? [])]
}

/**
 * Is this string, on its own, shaped like a GSTIN?
 *
 * Anchored and deliberately NOT built from GSTIN_PATTERN: that one carries the
 * `g` flag for findGstins, and a /g regex keeps `lastIndex` between calls, so
 * reusing it here would return alternating true/false for the same input.
 *
 * Shape only — there is no checksum validation, so a transposed character still
 * passes. Pair it with a PAN comparison against the entity the value is filed
 * under (see the warehouse route) to catch a valid GSTIN in the wrong slot.
 */
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/
export const isGstinShape = (s: string) => GSTIN_SHAPE.test(s.trim().toUpperCase())

/** The PAN embedded in a GSTIN. The same legal entity registered in another state
 *  differs only in the leading two characters, so this is the identity to compare. */
export const panOf = (gstin: string) => gstin.slice(2, 12)

/**
 * Our own GST registrations, by PAN.
 *
 * Every invoice carries at least two GSTINs — the supplier's and ours — and neither
 * `lookupMfgByGstin` nor `strategyFor` can tell them apart on its own: both take the
 * first entry that matches. That is safe today only because PEP isn't in master_mfgs,
 * which is an accident rather than a guarantee. It is worse for strategies: one
 * registered against a buyer GSTIN would fire on EVERY supplier's invoice.
 *
 * These four PANs cover the nine registrations seen across the sample set.
 * `tests/_check-invoice-detect.ts` re-derives the true set from any batch of invoices
 * by frequency — a GSTIN appearing under several supplier folders is the buyer's — so
 * drift here is detectable rather than silent.
 */
export const OUR_PANS = new Set(["AAICP2804J", "AAJCK9697F", "AAFCD3098K", "ABGCS1450A"])

export const isOurs = (gstin: string) => OUR_PANS.has(panOf(gstin))

/** Only the GSTINs that aren't ours — the safe input for a manufacturer lookup or
 *  strategy selection. Its own function so the filter is testable, because the
 *  failure mode is that this step quietly goes missing and everything still compiles. */
export const sellerGstinsOf = (gstins: string[]) => gstins.filter((g) => !isOurs(g))
