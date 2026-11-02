// One facility's sweep for Uniware POs no live ERP invoice owns. Reads Uniware, writes only uniware_external_po.
import { query, execute } from "@/lib/db"
import { uniwareExternalPoSql as sql } from "@/lib/queries/uniware-external-po"
import { listPurchaseOrderCodes, explorePoDetail } from "./po-explorer"
import { classifyExternalPo, mapPoDetail, type ExternalPoCandidate, type ExternalPoItem } from "./external-po"

export const EXTERNAL_PO_WINDOW_DAYS = 45
// Under the route's maxDuration; a cut-short facility finishes on the next press.
const BUDGET_MS = 240_000

export const externalPoSince = (now = new Date()) =>
  new Date(now.getTime() - EXTERNAL_PO_WINDOW_DAYS * 24 * 60 * 60 * 1000)

export type FacilitySweep = {
  facility: string
  listed: number
  owned: number
  detailed: number
  failed: number
  partial: boolean
  rows: ExternalPoCandidate[]
}

type CandidateRow = Omit<ExternalPoCandidate, "kind" | "items" | "un_created_at"> & {
  all_fg: number; adopted: number; items: ExternalPoItem[] | string; un_created_at: Date | string | null
}

export function toCandidate(r: CandidateRow): ExternalPoCandidate {
  const items = typeof r.items === "string" ? (JSON.parse(r.items) as ExternalPoItem[]) : r.items
  return {
    uniware_po_code: r.uniware_po_code,
    facility_code: r.facility_code,
    mfg_id: Number(r.mfg_id),
    mfg_code: r.mfg_code,
    reference_no: r.reference_no,
    un_status: r.un_status,
    un_created_by: r.un_created_by,
    un_created_at: r.un_created_at instanceof Date ? r.un_created_at.toISOString() : r.un_created_at,
    items,
    live_invoice_no: r.live_invoice_no,
    live_invoice_uniware_po_code: r.live_invoice_uniware_po_code,
    kind: classifyExternalPo({
      un_status: r.un_status, all_fg: Boolean(Number(r.all_fg)), adopted: Boolean(Number(r.adopted)),
      live_invoice_no: r.live_invoice_no,
    }),
  }
}

export async function sweepFacility(facility: string, now = new Date()): Promise<FacilitySweep> {
  const started = Date.now()
  const since = externalPoSince(now)
  const codes = await listPurchaseOrderCodes(facility, since, now)
  const out: FacilitySweep = { facility, listed: codes.length, owned: 0, detailed: 0, failed: 0, partial: false, rows: [] }

  if (codes.length) {
    const owned = new Set((await query<{ code: string }>(sql.selectOwnedCodes, [codes])).map((r) => r.code))
    out.owned = owned.size
    const cached = new Map(
      (await query<{ code: string; mfg_id: number | null; adopted: number; un_status: string | null }>(sql.selectCachedAmong, [codes]))
        .map((r) => [r.code, r])
    )
    // Cached non-manufacturer, adopted and cancelled rows can't change their answer; skip the detail call.
    const todo = codes.filter((c) => {
      if (owned.has(c)) return false
      const hit = cached.get(c)
      if (!hit) return true
      return hit.mfg_id != null && !Number(hit.adopted) && (hit.un_status ?? "").toUpperCase() !== "CANCELLED"
    })

    const vendorRows = await query<{ code: string; mfg_id: number }>(sql.selectMfgVendorCodes, [facility])
    const mfgByVendor = new Map<string, number>()
    for (const v of vendorRows) if (!mfgByVendor.has(v.code)) mfgByVendor.set(v.code, Number(v.mfg_id))

    for (const code of todo) {
      if (Date.now() - started > BUDGET_MS) { out.partial = true; break }
      try {
        const d = await explorePoDetail(code, facility)
        const m = mapPoDetail(d.header, d.items)
        const mfgId = m.vendor_code ? mfgByVendor.get(m.vendor_code.toUpperCase()) ?? null : null
        const skus = m.items.map((i) => i.sku_code)
        const fg = skus.length
          ? new Set((await query<{ sku_code: string }>(sql.selectFgSkuCodes, [skus])).map((r) => r.sku_code.toUpperCase()))
          : new Set<string>()
        const allFg = skus.length > 0 && skus.every((s) => fg.has(s.toUpperCase()))
        await execute(sql.upsert, [
          code, facility, m.vendor_code, mfgId, m.reference_no, m.un_status, m.grn_count,
          m.un_created_by, m.un_created_at, allFg ? 1 : 0, JSON.stringify(m.items),
        ])
        out.detailed++
      } catch {
        // One bad PO must not cost the facility its other answers.
        out.failed++
      }
    }
  }

  await execute(sql.reresolveMfg, [facility, facility])
  out.rows = (await query<CandidateRow>(sql.selectForFacility, [facility, since])).map(toCandidate)
  return out
}
