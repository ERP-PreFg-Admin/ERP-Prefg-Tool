/**
 * One inward PO per SKU — the collapse that keeps our PO table and Uniware's
 * showing the same thing.
 *
 * Its own module, not part of lib/invoice/invoice-inward.ts, because that file imports
 * S3/mailer/db and so cannot be loaded by a credential-free unit test. Same
 * reason lib/po-split.ts is split out of the route it serves.
 */

/**
 * One invoice line, after its receipt against an existing order has been
 * credited and before an inward PO is written for it.
 */
export type InwardLine = {
  skuCode: string
  skuName: string | null
  qty: number
  unitPrice: number | null
  totalAmount: number | null
  mrp: number | null
  /** Brand prefix for the inward PO number — from the order being settled. */
  brand: string
  /** The order this line was received against, and its number. */
  refPoId: number | null
  refPoNo: string | null
  recipeId: number | null
}

/**
 * Collapse repeated SKUs into one inward PO each — the mirror of
 * mergeItemsBySku() in lib/uniware.ts, so the two systems show the same PO.
 *
 * One SKU reaches here several times as a matter of course: the FIFO allocator
 * splits an invoice line covered by two open POs into two rows, and two invoice
 * lines can carry the same SKU. Uniware allows an itemSKU once per PO and gets
 * one merged entry; writing one PO per row on our side left the desk
 * reconciling three of our POs against one of theirs.
 *
 * Quantities sum and amounts sum. The unit price is quantity-weighted and
 * rounded to 2dp, exactly as mergeItemsBySku does, so the value of the PO still
 * equals the value of the lines. The per-line detail is not lost — every
 * invoice line keeps its own invoice_items_mfg row, with the order it was
 * received against.
 *
 * `refPoNo` / `recipeId` are the FIRST line's: reference_po is VARCHAR(50) and
 * holds one number, and the full mapping lives on the invoice lines.
 */
export function mergeInwardLinesBySku(lines: InwardLine[]): InwardLine[] {
  const bySku = new Map<string, InwardLine & { _value: number; _pricedQty: number }>()
  for (const l of lines) {
    const seen = bySku.get(l.skuCode)
    if (!seen) {
      bySku.set(l.skuCode, {
        ...l,
        _value:     l.unitPrice != null ? l.qty * l.unitPrice : 0,
        _pricedQty: l.unitPrice != null ? l.qty : 0,
      })
      continue
    }
    seen.qty += l.qty
    if (l.unitPrice != null) { seen._value += l.qty * l.unitPrice; seen._pricedQty += l.qty }
    if (l.totalAmount != null) seen.totalAmount = (seen.totalAmount ?? 0) + l.totalAmount
    // Descriptive fields describe the SKU, not the split — first non-null wins.
    seen.skuName  ??= l.skuName
    seen.mrp      ??= l.mrp
    seen.refPoNo  ??= l.refPoNo
    seen.refPoId  ??= l.refPoId
    seen.recipeId ??= l.recipeId
  }
  return [...bySku.values()].map(({ _value, _pricedQty, ...l }) => ({
    ...l,
    unitPrice: _pricedQty > 0 ? Math.round((_value / _pricedQty) * 100) / 100 : l.unitPrice,
  }))
}
