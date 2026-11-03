// Which POs an invoice line may book against. Shared by the Add Invoice FIFO and the
// server's re-check, so the two can't disagree. Pure: no DB, no env.

/** POs are raised against Mumbai first, so a Mumbai PO (or one with no destination) is every warehouse's fallback. */
export const DEFAULT_PO_DESTINATION = "Mumbai"

/** 0 = same warehouse, 1 = Mumbai fallback, 2 = another warehouse (never auto-picked; a hand pick is confirmed). */
export type DestinationTier = 0 | 1 | 2

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()

export function destinationTier(poDestination: string | null | undefined, invoiceDestination: string | null | undefined): DestinationTier {
  const inv = norm(invoiceDestination)
  const po = norm(poDestination) || norm(DEFAULT_PO_DESTINATION)
  if (po === inv) return 0
  return po === norm(DEFAULT_PO_DESTINATION) ? 1 : 2
}

/** The PO's warehouse as a person reads it: a blank one is shown as its Mumbai default. */
export const poDestinationLabel = (poDestination: string | null | undefined): string =>
  poDestination?.trim() || `${DEFAULT_PO_DESTINATION} (not set)`

export type RefPo = { id: number; po_no: string; mfg_id: number; sku_code: string | null; po_type: string | null }

/** Why a line can't book against this PO at all, or null. Destination is not here — it is a confirmable warning. */
export function referencePoBlock(po: RefPo | undefined, line: { sku_code?: string | null }, mfgId: number): string | null {
  if (!po) return "its reference PO no longer exists"
  if (Number(po.mfg_id) !== Number(mfgId)) return `${po.po_no} belongs to another manufacturer`
  if (po.po_type === "inward") return `${po.po_no} is an inward PO, not an order`
  if (line.sku_code && norm(line.sku_code) !== norm(po.sku_code)) return `${po.po_no} is for ${po.sku_code ?? "another SKU"}, not ${line.sku_code}`
  return null
}
