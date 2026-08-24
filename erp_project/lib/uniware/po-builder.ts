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

const iso = (d:string | Date | null | undefined) => 
    d == null ? undefined : d instanceof Date ? d.toISOString() : new Date(d).toISOString()
export function futureDeliveryDate(d:string | null | Date | undefined) : string | undefined {
    if(d == null ) return undefined
    const at = d instanceof Date ? d : new Date(d)
    if(Number.isNaN(at.getTime())) return undefined
    return at.getTime() > Date.now() ? at.toISOString() : undefined
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
        expiryDate: iso(po.expiryDate),
        deliveryDate: iso(po.deliveryDate),
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