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
