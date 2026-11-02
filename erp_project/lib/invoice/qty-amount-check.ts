// Per SKU, the invoice's own money says how many units it charges for: Σamount ÷ rate.
// Catches a parse that put an item's total on its first batch (RP/L/26-27/1557).
import { MATCH_TOLERANCE } from "@/lib/invoice/three-way"

type Num = string | number | null | undefined

export type QtyAmountLine = {
  sku_code: string
  qty: Num
  rate?: Num
  unit_price?: Num
  amount?: Num
  discount?: Num
}

export type QtyAmountMismatch = { sku_code: string; qty: number; expectedQty: number; rate: number; amount: number }

const n = (v: Num): number | null => {
  if (v == null || v === "") return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp

/** SKUs whose quantities disagree with their amount at their rate. Skips any SKU it can't check reliably. */
export function qtyAmountMismatches(lines: QtyAmountLine[]): QtyAmountMismatch[] {
  const bySku = new Map<string, QtyAmountLine[]>()
  for (const l of lines) {
    const key = (l.sku_code ?? "").trim().toLowerCase()
    if (!key) continue
    bySku.set(key, [...(bySku.get(key) ?? []), l])
  }

  const out: QtyAmountMismatch[] = []
  for (const group of bySku.values()) {
    // One price, no discount, and some pre-tax amount — otherwise the sum means nothing.
    const rates = new Set(group.map((l) => n(l.rate) ?? n(l.unit_price)).filter((r): r is number => r != null && r > 0))
    if (rates.size !== 1) continue
    if (group.some((l) => (n(l.discount) ?? 0) !== 0)) continue
    const amounts = group.map((l) => n(l.amount)).filter((a): a is number => a != null)
    if (amounts.length === 0) continue

    const rate = [...rates][0]
    const amount = amounts.reduce((s, a) => s + a, 0)
    const qty = group.reduce((s, l) => s + (n(l.qty) ?? 0), 0)
    const expectedQty = amount / rate
    if (expectedQty <= 0 || Math.abs(qty - expectedQty) <= expectedQty * MATCH_TOLERANCE) continue
    out.push({ sku_code: group[0].sku_code.trim(), qty: round(qty, 3), expectedQty: round(expectedQty, 3), rate, amount: round(amount, 2) })
  }
  return out
}

export function describeQtyAmountMismatch(m: QtyAmountMismatch): string {
  const money = `₹${m.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `${m.sku_code}: lines add up to ${m.qty.toLocaleString("en-IN")} but its amount ${money} at ₹${m.rate} is ` +
    `${Math.round(m.expectedQty).toLocaleString("en-IN")} units — check the batch quantities.`
}
