/**
 * Which Uniware facility to ask as, for a given mirrored invoice.
 *
 * Separate from ./facility.ts on purpose: that module is env-only and is pulled
 * in by every Uniware call, while this one reaches lib/db. Keeping them apart
 * means the endpoint/auth path stays importable by a unit test.
 *
 * Lifted out of app/api/v1/purchase-orders/uniware-status/route.ts when the GRN
 * sweep needed the same rule — two implementations of "which facility" would
 * eventually disagree about where a PO lives, and the failure mode is silent:
 * asking the wrong facility answers "not found", which reads as a real status or
 * as "this PO has no GRNs".
 */

import { query } from "@/lib/db"
import { warehouse } from "@/lib/queries/warehouse"
import { panOf } from "@/lib/invoice/gstin"
import { UNIWARE_SANDBOX } from "@/lib/env"

/** The three fields any caller must carry to resolve a facility. */
export type FacilityLookup = {
  destination: string | null
  buyer_gstin: string | null
}

/**
 * The destination site, under the entity that was billed.
 *
 * Matched on **PAN, never the full GSTIN**: Pep operates most sites and Kreative
 * bills Mumbai while shipping everywhere, so the state code in a GSTIN does not
 * identify the legal entity. Same resolver the push uses, so the two cannot
 * disagree.
 *
 * ponytail: one query per row rather than a join in each list SQL, so the PAN
 * rule has exactly one implementation. The local round trip is noise beside the
 * Uniware call that follows it.
 */
export async function facilityForInvoice(row: FacilityLookup): Promise<string | undefined> {
  const pan = row.buyer_gstin?.trim() ? panOf(row.buyer_gstin.trim()) : null
  if (!pan) return undefined
  const rows = await query<{ facility_code: string | null }>(
    warehouse.facilityByDestinationAndPan,
    [row.destination, pan]
  )
  return rows[0]?.facility_code?.trim() || undefined
}

/**
 * Resolve, or explain why we must not proceed.
 *
 * Off prod the facility is pinned to the sandbox anyway (uniwareFacility swaps
 * it in), so an unmapped destination is not a reason to skip. On prod it is:
 * asking the wrong facility returns a successful-looking answer about a PO that
 * isn't there, and this API never errors on a bad lookup — it answers empty.
 *
 * Throws so each caller's per-row catch reports it against that PO rather than
 * storing a wrong answer.
 */
export async function requireFacilityForInvoice(row: FacilityLookup): Promise<string | undefined> {
  const facility = await facilityForInvoice(row)
  if (!facility && !UNIWARE_SANDBOX) {
    throw new Error(
      `'${row.destination}' has no active Uniware facility for the entity billed on this invoice. ` +
      "Set it on /masters/warehouses."
    )
  }
  return facility
}
