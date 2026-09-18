import { todayIST } from "@/lib/date"

export type UniwarePoItem = {
    itemSKU: string
    quantity: number
    unitPrice : number
    maxRetailPrice?: number | null
    discount?: number | null
    discountPercentage?: number | null
    taxTypeCode?: string | null
}

export type UniwarePoInput = {
  facility? : string
  purchaseOrderCode?: string
  vendorCode: string
  vendorAgreementName?: string | null
  currencyCode?: string | null
  expiryDate?: string | Date | null
  deliveryDate?: string | Date | null
  logisticCharges?: number | null
  logisticChargesDivisionMethod?: string | null
  items: UniwarePoItem[]
  customFields?: Record<string, string>
}

/**
 * A DATE, not a timestamp — `YYYY-MM-DD`, in IST.
 *
 * Uniware stores these two fields as dates: send 2026-10-03T11:50:26.031Z and
 * read the PO back and it holds "2026-10-03". The time was always discarded, so
 * sending it only invited the reader to believe a precision that does not exist.
 *
 * IST, not UTC, and that is the whole reason this is not `.toISOString()
 * .slice(0,10)`: the container runs UTC, so any punch between 00:00 and 05:30
 * IST falls on the PREVIOUS UTC day and the PO would be dated a day early —
 * a bug that reads correctly on a laptop in India and wrongly in production.
 * Same reason todayIST() exists.
 */
const dateOnly = (d: string | Date | null | undefined) => {
    if (d == null) return undefined
    const at = d instanceof Date ? d : new Date(d)
    return Number.isNaN(at.getTime()) ? undefined : todayIST(at)
}
export function futureDeliveryDate(d:string | null | Date | undefined) : string | undefined {
    if(d == null ) return undefined
    const at = d instanceof Date ? d : new Date(d)
    if(Number.isNaN(at.getTime())) return undefined
    return at.getTime() > Date.now() ? at.toISOString() : undefined
}

/**
 * How long an inward PO stays open in Uniware, from the moment it is punched.
 *
 * An inward PO is raised against goods that have ALREADY arrived, so there is
 * no real future delivery date to send — the invoice date is in the past and
 * Uniware only accepts a future one, which is why deliveryDate has been
 * silently omitted on every inward PO so far. Fifteen days is a window wide
 * enough for the receipt to be booked against it and narrow enough that a PO
 * nobody actioned does not sit open forever.
 */
export const INWARD_PO_VALIDITY_DAYS = 15

/**
 * The IST calendar date `days` after the punch, as `YYYY-MM-DD`.
 *
 * A date, not a timestamp: Uniware discards the time on these fields anyway
 * (see dateOnly), so the window is really 15 calendar days and the punch minute
 * never matters.
 *
 * Takes `now` so it is testable without freezing the clock.
 */
export function punchPlusDays(days: number, now: Date = new Date()): string {
    return todayIST(new Date(now.getTime() + days * 24 * 60 * 60 * 1000))
}

const numOrUndef = (v : unknown) => 
    v == null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v)

export function mergeItemsBySku(items: UniwarePoItem[]): UniwarePoItem[] {
  const bySku = new Map<string, UniwarePoItem & { _value: number }>()
  for (const it of items) {
    const qty = Number(it.quantity)
    const price = Number(it.unitPrice ?? 0)
    const seen = bySku.get(it.itemSKU)
    if (!seen) {
      bySku.set(it.itemSKU, { ...it, quantity: qty, _value: qty * price })
      continue
    }
    seen.quantity += qty
    seen._value += qty * price
    seen.maxRetailPrice ??= it.maxRetailPrice
    seen.taxTypeCode ??= it.taxTypeCode
  }
  return [...bySku.values()].map(({ _value, ...it }) => ({
    ...it,
    unitPrice: it.quantity > 0 ? Math.round((_value / it.quantity) * 100) / 100 : it.unitPrice,
  }))
}

export function buildPurchaseOrder(po : UniwarePoInput) {
    if(!po.vendorCode)  throw new Error("vendorCode is required")
    if(!po.items?.length) throw new Error("At least one purchase order item is required")
    po.items.forEach((it , i) => {
        if (!it.itemSKU) throw new Error(`items[${i}].itemSKU is required`)
        if (!(Number(it.quantity) > 0)) throw new Error(`items[${i}].quantity must be > 0`)
        if (it.unitPrice == null) throw new Error(`items[${i}].unitPrice is required`)
    })

    // After validation, so a bad row is still reported against its own index.
    const items = mergeItemsBySku(po.items)

    const payload = {
        purchaseOrderCode: po.purchaseOrderCode,
        type: "MANUAL", // the only value this endpoint documents
        vendorCode: po.vendorCode,
        vendorAgreementName: po.vendorAgreementName ?? undefined,
        currencyCode: po.currencyCode || "INR",
        expiryDate: dateOnly(po.expiryDate),
        deliveryDate: dateOnly(po.deliveryDate),
        logisticChargesDivisionMethod: po.logisticChargesDivisionMethod ?? undefined,
        logisticCharges: numOrUndef(po.logisticCharges),
        purchaseOrderItems: items.map((it) => ({
            itemSKU: it.itemSKU,
            quantity: Number(it.quantity),
            unitPrice: Number(it.unitPrice),
            maxRetailPrice: numOrUndef(it.maxRetailPrice),
            discount: numOrUndef(it.discount),
            discountPercentage: numOrUndef(it.discountPercentage),
            taxTypeCode: it.taxTypeCode ?? undefined,
        })),
        customFieldValues: po.customFields
            ? Object.entries(po.customFields).map(([name, value]) => ({ name, value: String(value) }))
            : undefined,
    }

    // Drop undefined so optional fields are absent rather than null — Uniware
    // treats an explicit null as a value and rejects some of them.
    return JSON.parse(JSON.stringify(payload))
}