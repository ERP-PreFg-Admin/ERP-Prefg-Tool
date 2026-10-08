// The PO bulk upload checks (lib/po/po-bulk-check.ts) wired to MySQL: the preview
// shows the flags and notes; staging writes the server's type and price into the CSV.

import { query } from "@/lib/db"
import { skus as skusSql } from "@/lib/queries/skus"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { agreedRatesByMfg, type AgreedRate } from "@/lib/costing/agreed-rates"
import { skuGstPercent } from "@/lib/po/po-rate"
import { destinationAllowed, type DestinationEntityRow } from "@/lib/po/po-guard"
import { checkBulkRows, type BulkCheck, type BulkFacts, type BulkUpdateTarget } from "@/lib/po/po-bulk-check"

export { STAGED_PRICE_KEYS, type BulkCheck } from "@/lib/po/po-bulk-check"

/** Lookups against the live schema, cached for the length of one file. */
export function dbBulkFacts(): BulkFacts {
  const mfgs = new Map<string, { id: number; code: string } | null>()
  const skus = new Map<string, boolean>()
  const rates = new Map<number, Map<string, AgreedRate>>()
  const gst = new Map<string, number | null>()
  return {
    async mfgByCode(code) {
      if (!mfgs.has(code)) {
        const [m] = await query<{ id: number; code: string }>(`SELECT id, code FROM master_mfgs WHERE code = ? LIMIT 1`, [code])
        mfgs.set(code, m ?? null)
      }
      return mfgs.get(code)!
    },
    async skuExists(skuCode) {
      const k = skuCode.toLowerCase()
      if (!skus.has(k)) skus.set(k, (await query(skusSql.selectStatusAndBrandByCode, [skuCode])).length > 0)
      return skus.get(k)!
    },
    async poByNo(poNo) {
      const [po] = await query<BulkUpdateTarget & { po_type: string | null; sku_code: string | null }>(purchaseOrdersSql.selectByPoNo, [poNo])
      return po ?? null
    },
    async destination(name, skuCode) {
      const [w] = await query<{ name: string; status: string | null }>(purchaseOrdersSql.selectWarehouseByName, [name])
      if (!w) return null
      // No SKU (unknown code): existence and status only — there is no entity to check against.
      const [e] = skuCode
        ? await query<DestinationEntityRow>(purchaseOrdersSql.selectDestinationEntityCheck, [w.name, w.name, skuCode])
        : []
      return { name: w.name, active: w.status === "active", allowed: e ? destinationAllowed(e) : true, entity: e?.entity_code ?? null }
    },
    async liveSpecialPo(mfgId, skuCode, poType) {
      const [row] = await query<{ po_no: string }>(purchaseOrdersSql.selectLiveSpecialPo, [mfgId, skuCode, poType])
      return row?.po_no ?? null
    },
    async rate(mfgId, skuCode) {
      if (!rates.has(mfgId)) {
        // Lower-cased: sku_code casing drifts from master_skus (see lib/po/po-rate.ts).
        rates.set(mfgId, new Map([...(await agreedRatesByMfg(mfgId, null))].map(([k, v]) => [k.toLowerCase(), v])))
      }
      const k = skuCode.toLowerCase()
      if (!gst.has(k)) gst.set(k, await skuGstPercent(skuCode))
      return { agreed: rates.get(mfgId)!.get(k), gstPercent: gst.get(k)! }
    },
  }
}

export const priceBulkRows = (rows: Record<string, string>[]): Promise<BulkCheck> =>
  checkBulkRows(rows, dbBulkFacts(), new Date().toISOString())
