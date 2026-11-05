// Which invoices one document-sync run takes. Pure, so the slot rule is unit-tested.

/** Up to this many slots go to PDFs that never reached Uniware; the rest stay with the newest invoices. */
export const RETRY_SLOTS = 20

/**
 * Retries first (capped, so an upload that keeps failing can't crowd out new invoices),
 * then the newest, without repeats. `truncated` says invoices were left for a later run.
 */
export function composeDocBatch<T extends { id: number }>(
  retries: T[], newest: T[], limit: number, retrySlots = RETRY_SLOTS,
): { batch: T[]; truncated: boolean } {
  const batch = retries.slice(0, Math.min(retrySlots, limit))
  const taken = new Set(batch.map((r) => r.id))
  for (const r of newest) {
    if (batch.length >= limit) break
    if (!taken.has(r.id)) { batch.push(r); taken.add(r.id) }
  }
  return { batch, truncated: [...retries, ...newest].some((r) => !taken.has(r.id)) }
}
