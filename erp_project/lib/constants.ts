/**
 * Shared status constants for entity and approval records.
 *
 * Use these instead of raw string literals so typos become compile errors
 * and a rename is a single change rather than a grep-and-replace.
 */

/**
 * Branding shown in the top bar. APP_VERSION is the single place the release
 * label lives — bump it here and the header follows.
 */
export const APP_NAME = "House of Pep"
export const APP_VERSION = "PreFG v1.0.0"

export const STATUS = {
  ACTIVE:    "active",
  DRAFT:     "draft",
  IN_REVIEW: "in_review",
  INACTIVE:  "inactive",
  REJECTED:  "rejected",
} as const

export type EntityStatus = typeof STATUS[keyof typeof STATUS]

export const APPROVAL_STATUS = {
  PENDING:  "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const

export type ApprovalStatus = typeof APPROVAL_STATUS[keyof typeof APPROVAL_STATUS]

/**
 * The single mapping from an approval status to its badge variant — every
 * approved/rejected/pending pill in the app (the /approvals queue, history,
 * and the per-entity History table) reads this instead of hand-rolling its
 * own bg/border/dark: classes, which is how "approved" ended up rendered in
 * two different shades of green in different files.
 */
export const APPROVAL_STATUS_VARIANT: Record<ApprovalStatus, "success" | "destructive" | "warning"> = {
  [APPROVAL_STATUS.APPROVED]: "success",
  [APPROVAL_STATUS.REJECTED]: "destructive",
  [APPROVAL_STATUS.PENDING]:  "warning",
}

/**
 * Brand codes used for PO prefixes and their legal entities.
 * Keys are normalized forms of master_skus.brand, which may vary
 * in case or formatting (e.g. "mCaffeine", "MCAFFEINE", "m-caffeine").
 * Centralizes mappings previously duplicated across PO/invoice handlers.
 */
const BRANDS : Record<string , {code: string , entity : string}> = {
  mcaffeine: {
    code: "MCAFF" , 
    entity: "PEP"
  },
  fein: {
    code: "FEIN",
    entity: "PEP",
  },
  hyphen: {
    code:"HYP" , 
    entity: "KREATIVE"
  }
}

const brandKey = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]/g , "")
/**
 * Short code used as the PO number prefix.
 * Unmapped brands retain their upper-cased name for PO stability.
 */
/**
 * Legal entity code for this brand, or null if unmapped.
 * Do not guess missing mappings; DWH brands may be added before this is updated.
 * Uniware routing uses the invoice's buyer_gstin instead.
 */

export function brandCode(raw:string):string {
  return (BRANDS[brandKey(raw)]?.code ?? raw).toUpperCase()
}

export function entityForBrand(brand: string | null | undefined) : string | null {
  if(!brand) return null
  return BRANDS[brandKey(brand)]?.entity ?? null;
}

/**
 * The leading letter of an ERP-minted Uniware PO code — M/MUM1/2627/01234.
 *
 * Keyed on master_entity.code, not on brand: one Uniware PO carries every SKU on
 * an invoice and can therefore span brands, while the facility it is raised at is
 * (location x legal entity) and so has exactly one entity. Derived rather than
 * stored per facility so the two rows of one site cannot disagree about it.
 *
 * Matches the live tenant, which uses these two letters already: over 4,683 codes
 * carrying one, H never appeared in a Pep facility nor M in a Kreative one.
 *
 * Lives here beside BRANDS because this file is already the authority for PO
 * prefixes — see prisma/add_master_brand.sql:34-35, where master_brand is the
 * authority for scoping and this map is the authority for prefixes.
 */
const ENTITY_PO_LETTER: Record<string, string> = {
  PEP: "M",        // mCaffeine
  KREATIVE: "H",   // Hyphen
}

/**
 * PO-code letter for a legal entity, or null when the entity is unmapped.
 *
 * Null is deliberate and must not be defaulted: a guessed letter would mint a
 * plausible-looking code in the wrong series, which is worse than not minting one
 * at all. Callers treat null the same as an unconfigured facility and let Uniware
 * number the PO.
 */
export function poLetterForEntity(entityCode: string | null | undefined): string | null {
  if (!entityCode) return null
  return ENTITY_PO_LETTER[entityCode.trim().toUpperCase()] ?? null
}




