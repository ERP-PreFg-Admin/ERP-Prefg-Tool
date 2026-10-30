// Charges (freight etc.) grossed for GST — shared by the Add Invoice screen and the server's total check.

/** Most common GST rate on the goods lines; the fallback for a charge that doesn't state its own. */
export function goodsGstPercent(lines: { gst_percent?: unknown }[]): number {
  const counts = new Map<number, number>()
  for (const l of lines) {
    const g = Number(l.gst_percent)
    if (Number.isFinite(g) && g > 0) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [rate, n] of counts) if (n > bestCount) { best = rate; bestCount = n }
  return best
}

/** Charges summed pre GST, and their GST, for invoice_mfg.freight_amount / freight_tax. Null when there are none. */
export function chargeTotals(
  charges: { amount: number | string; gst_percent?: number | string | null }[],
  fallbackGst: number
): { amount: number; tax: number } | null {
  let amount = 0
  let tax = 0
  for (const c of charges) {
    const a = Number(c.amount)
    if (!Number.isFinite(a)) continue
    const gst = Number(c.gst_percent ?? fallbackGst)
    amount += a
    tax += a * (Number.isFinite(gst) ? gst : 0) / 100
  }
  return amount === 0 ? null : { amount, tax }
}

/** Charges including GST, comparable with the invoice's post-tax total. Kain's ₹7,000 freight carries ₹1,260. */
export function sumCharges(
  charges: { amount: number | string; gst_percent?: number | string | null }[],
  fallbackGst: number
): number {
  return charges.reduce((sum, c) => {
    const amount = Number(c.amount)
    if (!Number.isFinite(amount)) return sum
    const gst = Number(c.gst_percent ?? fallbackGst)
    return sum + amount * (1 + (Number.isFinite(gst) ? gst : 0) / 100)
  }, 0)
}
