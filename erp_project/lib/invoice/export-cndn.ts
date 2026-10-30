// CN/DN for the invoice export: (agreed FG costing on the invoice date − invoice rate) × qty, per line.
import { agreedRatesByMfg } from "@/lib/costing/agreed-rates"

type ExportLine = Record<string, unknown> & {
  invoice_id: number
  mfg_id: number
  invoice_date_iso: string | null
  sku_code: string | null
  rate: unknown
  qty: unknown
}

const CONCURRENCY = 6
const round2 = (n: number) => Math.round(n * 100) / 100

/** Sets `agreed_rate` and `cn_dn` on every line (null when there is no agreed costing or no rate) and returns the per-invoice sums. */
export async function applyCnDn(lines: ExportLine[]): Promise<Map<number, number>> {
  // One as-of costing per (manufacturer, invoice date); lower-cased keys, as po-rate does.
  const pairs = new Map<string, { mfgId: number; asOf: string }>()
  for (const l of lines) {
    if (l.invoice_date_iso && l.mfg_id) pairs.set(`${l.mfg_id}|${l.invoice_date_iso}`, { mfgId: l.mfg_id, asOf: l.invoice_date_iso })
  }
  const costing = new Map<string, Map<string, number>>()
  const queue = [...pairs]
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, { mfgId, asOf }] = next
      const rates = await agreedRatesByMfg(mfgId, null, asOf)
      // A zero total is "no costing", as po-rate treats it, not a free SKU.
      costing.set(key, new Map([...rates].filter(([, r]) => r.rate > 0).map(([sku, r]) => [sku.toLowerCase(), r.rate])))
    }
  }))

  const byInvoice = new Map<number, number>()
  for (const l of lines) {
    const agreed = l.sku_code ? costing.get(`${l.mfg_id}|${l.invoice_date_iso}`)?.get(l.sku_code.toLowerCase()) : undefined
    l.agreed_rate = agreed == null ? null : round2(agreed)
    const rate = Number(l.rate)
    const qty = Number(l.qty)
    if (agreed == null || l.rate == null || !Number.isFinite(rate) || !Number.isFinite(qty)) {
      l.cn_dn = null
      continue
    }
    const value = round2((agreed - rate) * qty)
    l.cn_dn = value
    byInvoice.set(l.invoice_id, round2((byInvoice.get(l.invoice_id) ?? 0) + value))
  }
  return byInvoice
}
