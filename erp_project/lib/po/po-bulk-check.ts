// Every rule a PO bulk row is checked against at upload, with the lookups passed in
// (BulkFacts) so the rules are testable without a database. Wired to MySQL in
// lib/po/po-bulk-pricing.ts. See docs/po-bulk-type-plan.md.

import { classifyRate, rateNote, type AgreedRateInput } from "./po-rate-note"
import { isSpecialPoType, parseBulkPoType, poTypeRequiresRemarks, isDraftPo, BULK_PO_TYPES } from "./po-rules"
import { isoDate, normalizeDateCell } from "../date"

/** The only statuses a CSV may set. Receipt statuses come from receiving. */
export const BULK_SETTABLE_STATUSES = ["raised", "cancelled", "short_closed"] as const

export type BulkUpdateTarget = {
  po_no: string
  status: string | null
  email_sent_at: string | Date | null
  expected_on: string | Date | null
  destination: string | null
  remarks: string | null
}

/**
 * Why a CSV update row may not touch this PO, or null. A draft (stored draft, or
 * raised but not yet mailed) may be edited freely; once the manufacturer has the
 * mail, only cancel or short-close. Compared with the PO's current values, so a
 * re-uploaded export that only cancels isn't blocked by its unchanged columns.
 */
export function bulkUpdateBlock(po: BulkUpdateTarget, row: Record<string, string | undefined>): string | null {
  const status = row.status?.trim().toLowerCase() || null
  const statusChange = !!status && status !== po.status
  if (statusChange && !(BULK_SETTABLE_STATUSES as readonly string[]).includes(status!)) {
    return `A CSV can only set status to ${BULK_SETTABLE_STATUSES.join(", ")} (got "${row.status}")`
  }
  if (isDraftPo({ status: po.status, email_sent_at: po.email_sent_at })) return null

  const date = normalizeDateCell(row.expected_on)
  const dest = row.destination?.trim()
  const remarks = row.remarks?.trim()
  const editsFields =
    (!!date && date !== isoDate(po.expected_on)) ||
    (!!dest && dest.toLowerCase() !== (po.destination ?? "").trim().toLowerCase()) ||
    (!!remarks && remarks.slice(0, 300) !== (po.remarks ?? "").trim())
  if (editsFields || (statusChange && status === "raised")) {
    const why = po.email_sent_at ? "has been sent to the manufacturer" : `is ${(po.status ?? "").replace(/_/g, " ")}`
    return `${po.po_no} ${why} — a CSV can only cancel or short-close it now`
  }
  return null
}

/** Server-written columns; any client value under these keys is overwritten. */
export const STAGED_PRICE_KEYS = ["po_type", "unit_price", "gst_percent", "amount_pre_gst", "total_amount", "costing_note", "priced_at"] as const

export type BulkFacts = {
  mfgByCode(code: string): Promise<{ id: number; code: string } | null>
  skuExists(skuCode: string): Promise<boolean>
  poByNo(poNo: string): Promise<(BulkUpdateTarget & { po_type: string | null; sku_code: string | null }) | null>
  /** The warehouse by name (canonical spelling + status), and whether it serves the
   *  SKU's legal entity — the rule single Add PO applies (destinationAllowed). */
  destination(name: string, skuCode: string | null): Promise<{ name: string; active: boolean; allowed: boolean; entity: string | null } | null>
  liveSpecialPo(mfgId: number, skuCode: string, poType: string): Promise<string | null>
  /** The SKU's agreed rate at the mfg (undefined = no recipe there) and its GST. */
  rate(mfgId: number, skuCode: string): Promise<{ agreed: AgreedRateInput | undefined; gstPercent: number | null }>
}

export type BulkCheck = {
  /** Blocking, per row index — the row is left out. */
  flags: Record<number, string[]>
  /** Non-blocking, per row index. */
  info: Record<number, string[]>
  /** Rows flagged because their SKU is not in master_skus (for the toast). */
  unknownSkus: number
  /** Unflagged rows with the server-decided columns, ready to stage. */
  staged: Record<string, string>[]
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a")

/** Flags for a destination cell; returns the canonical warehouse name to stage. */
async function checkDestination(
  raw: string, skuCode: string | null, facts: BulkFacts, flag: (m: string) => void,
): Promise<string | null> {
  const w = await facts.destination(raw, skuCode)
  if (!w) { flag(`Destination "${raw}" is not a warehouse`); return null }
  if (!w.active) { flag(`Destination ${w.name} is not an active warehouse`); return null }
  if (!w.allowed) { flag(`${w.name} isn't a ${w.entity} facility — this SKU's POs can only be sent to ${w.entity}'s warehouses`); return null }
  return w.name
}

export async function checkBulkRows(rows: Record<string, string>[], facts: BulkFacts, pricedAt: string): Promise<BulkCheck> {
  const flags: Record<number, string[]> = {}
  const info: Record<number, string[]> = {}
  const staged: Record<string, string>[] = []
  const specialInFile = new Set<string>()
  let unknownSkus = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const out: Record<string, string> = {
      ...row, po_type: "", unit_price: "", gst_percent: "", amount_pre_gst: "", total_amount: "", costing_note: "", priced_at: pricedAt,
    }
    const rowFlags: string[] = []
    const note = (text: string) => { info[i] = [text]; out.costing_note = text }

    const poNo = row.po_no?.trim()
    const mfgCode = row.mfg_code?.trim() ?? ""
    const skuCode = row.sku_code?.trim() ?? ""
    const qty = Number(row.qty)
    const type = parseBulkPoType(row.po_type)

    if (type === "invalid") {
      rowFlags.push(`PO type "${row.po_type}" is not one of ${BULK_PO_TYPES.join(", ")}`)
    } else if (poNo) {
      const existing = await facts.poByNo(poNo)
      const current = existing?.po_type ?? "normal"
      if (!existing) note(`PO ${poNo} not found — will be skipped`)
      else if (row.po_type?.trim() && type !== current) rowFlags.push(`An update can't change the PO type (${poNo} is ${current})`)
      else if (bulkUpdateBlock(existing, row)) rowFlags.push(bulkUpdateBlock(existing, row)!)
      else {
        // Blank keeps the PO's destination; a new one is checked like a create.
        const dest = row.destination?.trim()
        if (dest) {
          const name = await checkDestination(dest, existing.sku_code, facts, (m) => rowFlags.push(m))
          if (name) out.destination = name
        }
        note(`Updates ${poNo} — price unchanged`)
      }
    } else if (!mfgCode || !skuCode || !Number.isFinite(qty) || qty <= 0) {
      rowFlags.push("A new PO needs mfg_code, sku_code and a positive qty")
    } else {
      out.po_type = type
      if (poTypeRequiresRemarks(type) && !row.remarks?.trim()) rowFlags.push(`Remarks are required for ${article(type)} ${type} PO`)

      const mfg = await facts.mfgByCode(mfgCode)
      const skuKnown = await facts.skuExists(skuCode)
      if (!mfg) rowFlags.push(`Manufacturer ${mfgCode} not found`)
      if (!skuKnown) { rowFlags.push(`SKU ${skuCode} is not in SKU Master`); unknownSkus++ }

      const dest = row.destination?.trim()
      if (!dest) rowFlags.push("Destination is required — name a warehouse")
      else {
        const name = await checkDestination(dest, skuKnown ? skuCode : null, facts, (m) => rowFlags.push(m))
        if (name) out.destination = name
      }

      if (mfg && skuKnown) {
        const pairKey = `${mfg.id}|${skuCode.toLowerCase()}|${type}`
        if (isSpecialPoType(type)) {
          const existingPo = await facts.liveSpecialPo(mfg.id, skuCode, type)
          if (existingPo) rowFlags.push(`A ${type} PO is already raised for ${skuCode} at ${mfg.code}: ${existingPo}`)
          else if (specialInFile.has(pairKey)) rowFlags.push(`Another ${type} row for ${skuCode} at ${mfg.code} is earlier in this file`)
        }
        const { agreed, gstPercent } = await facts.rate(mfg.id, skuCode)
        const v = classifyRate(agreed, qty, gstPercent, type)
        const s = (n: number | null) => (n == null ? "" : String(n))
        out.unit_price = s(v.unitPrice)
        out.gst_percent = String(v.gstPercent)
        out.amount_pre_gst = s(v.amountPreGst)
        out.total_amount = s(v.totalAmount)
        note(rateNote(v, qty, mfg.code))
        // Only a row that will actually be uploaded claims its pair.
        if (isSpecialPoType(type) && rowFlags.length === 0) specialInFile.add(pairKey)
      }
    }

    if (rowFlags.length) flags[i] = rowFlags
    else staged.push(out)
  }
  return { flags, info, unknownSkus, staged }
}
