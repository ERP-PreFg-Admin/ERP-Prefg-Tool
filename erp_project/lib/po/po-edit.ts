// Editing a Draft PO (raised, not yet mailed) goes through approval: plan at submit
// (validate + diff, no write), apply on approve. Both take the caller's open
// transaction, like po-receive.ts, so they are testable under withRollback.

import type { PoolConnection } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { isoDate, todayIST } from "@/lib/date"
import { canDirectEditPo, impliedGstPercent, isSpecialPoType, poTotal, specialPoPrice } from "@/lib/po/po-rules"
import { resolvePoUnit, type MfgUnitOption } from "@/lib/po/po-unit"

/** Omitted fields stay as they are. */
export type DraftPoEdit = {
  qty?: number
  expected_on?: string | null
  destination?: string | null
  remarks?: string | null
  /** Supplier unit code (MBA / MB2); only for a manufacturer with units. */
  mfg_unit?: string | null
  reason: string
}

export const DRAFT_EDIT_FIELDS = ["qty", "expected_on", "destination", "remarks", "mfg_unit"] as const
export type DraftPoChange = { field: (typeof DRAFT_EDIT_FIELDS)[number]; old: string; new: string }

export type DraftEditPlan = {
  po: LockedPo
  reason: string
  changes: DraftPoChange[]
  qty: number
  next: { expected_on: string; destination: string; remarks: string }
  /** Set only when the unit changes. */
  nextUnitId: number | null
  amountPreGst: string | number | null
  totalAmount: string | number | null
}

type LockedPo = {
  id: number
  po_no: string
  mfg_id: number
  effective_unit_id: number | null
  sku_code: string | null
  status: string
  email_sent_at: string | Date | null
  po_type: string | null
  reference_po: string | null
  qty: string | number
  received_qty: string | number
  unit_price: string | number | null
  amount_pre_gst: string | number | null
  total_amount: string | number | null
  expected_on: string | Date | null
  destination: string | null
  remarks: string | null
  sku_gst: string | number | null
  child_count: string | number
}

const blank = (v: string | null | undefined) => (v ?? "").trim()

/** Locks the PO and checks the edit is still allowed; writes nothing. */
export async function planDraftPoEdit(conn: PoolConnection, poId: number, edit: DraftPoEdit): Promise<DraftEditPlan> {
  const [rows] = await conn.execute(purchaseOrdersSql.selectForDraftEditLocked, [poId])
  const po = (rows as LockedPo[])[0]
  if (!po) throw new ApiError(404, "not_found", "Purchase order not found")

  // Re-checked on the locked row: the PO may have been mailed since the edit was opened.
  if (po.email_sent_at) {
    throw new ApiError(409, "po_already_sent", `${po.po_no} has already been mailed to the manufacturer — cancel or short-close it instead.`)
  }
  if (!canDirectEditPo(po) || Number(po.child_count) > 0) {
    throw new ApiError(409, "po_not_editable", `${po.po_no} can't be edited — only a Draft PO that hasn't been split can be.`)
  }

  const reason = blank(edit.reason)
  if (!reason) throw new ApiError(400, "reason_required", "Give a reason for the edit.")

  const qty = edit.qty === undefined ? Number(po.qty) : Number(edit.qty)
  if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, "invalid_qty", "Quantity must be greater than 0.")
  if (qty < Number(po.received_qty)) {
    throw new ApiError(400, "qty_below_received", `Quantity can't go below the ${Number(po.received_qty)} already received.`)
  }

  const prev = {
    expected_on: isoDate(po.expected_on),
    destination: blank(po.destination),
    remarks: blank(po.remarks),
  }
  const pick = (f: keyof typeof prev) => (edit[f] === undefined ? prev[f] : blank(edit[f]))
  const next = { expected_on: pick("expected_on"), destination: pick("destination"), remarks: pick("remarks").slice(0, 300) }

  if (!next.remarks && (po.po_type === "impromptu" || isSpecialPoType(po.po_type))) {
    throw new ApiError(400, "remarks_required", `Remarks can't be cleared on ${po.po_type === "impromptu" ? "an impromptu" : "a special-type"} PO.`)
  }
  if (next.expected_on && next.expected_on !== prev.expected_on && next.expected_on < todayIST()) {
    throw new ApiError(400, "expected_on_past", "Backdating is not allowed for expected dispatch date.")
  }

  const changes: DraftPoChange[] = []
  if (qty !== Number(po.qty)) changes.push({ field: "qty", old: String(Number(po.qty)), new: String(qty) })
  for (const f of ["expected_on", "destination", "remarks"] as const) {
    if (next[f] !== prev[f]) changes.push({ field: f, old: prev[f], new: next[f] })
  }

  let nextUnitId: number | null = null
  if (blank(edit.mfg_unit)) {
    const [unitRows] = await conn.execute(purchaseOrdersSql.selectActiveMfgUnits, [po.mfg_id])
    const units = unitRows as MfgUnitOption[]
    const r = resolvePoUnit(units, null, blank(edit.mfg_unit))
    if (!r.ok) throw new ApiError(400, r.code, r.message)
    if (r.unitId !== po.effective_unit_id) {
      const code = (id: number | null) => units.find((u) => u.id === id)?.unit_code ?? ""
      changes.push({ field: "mfg_unit", old: code(po.effective_unit_id), new: code(r.unitId) })
      nextUnitId = r.unitId
    }
  }
  if (changes.length === 0) throw new ApiError(400, "no_changes", "Nothing changed.")

  // Amounts move only with qty, so a date-only edit can't re-round a figure already on the PO.
  let amountPreGst = po.amount_pre_gst
  let totalAmount = po.total_amount
  if (qty !== Number(po.qty)) {
    const price = isSpecialPoType(po.po_type)
      ? specialPoPrice()
      : poTotal(po.unit_price, qty, impliedGstPercent(po.amount_pre_gst, po.total_amount) ?? po.sku_gst)
    amountPreGst = price.amountPreGst
    totalAmount = price.totalAmount
  }

  return { po, reason, changes, qty, next, nextUnitId, amountPreGst, totalAmount }
}

/** Applies an approved edit: one history_pos row per changed field plus the reason,
 *  credited to `changedBy` (the submitter). Rate is kept; amounts follow qty. */
export async function applyDraftPoEdit(
  conn: PoolConnection,
  poId: number,
  edit: DraftPoEdit,
  changedBy: number,
): Promise<{ po_no: string; changes: DraftPoChange[] }> {
  const p = await planDraftPoEdit(conn, poId, edit)

  await conn.execute(purchaseOrdersSql.updateDraftFields, [
    p.qty, p.amountPreGst, p.totalAmount,
    p.next.expected_on || null, p.next.destination || null, p.next.remarks || null,
    p.po.id,
  ])
  if (p.nextUnitId !== null) await conn.execute(purchaseOrdersSql.setMfgUnit, [p.nextUnitId, p.po.id])
  for (const c of p.changes) {
    await conn.execute(purchaseOrdersSql.insertPoHistory, [p.po.id, p.po.po_no, "update", c.field, c.old, c.new, null, changedBy])
  }
  await conn.execute(purchaseOrdersSql.insertPoHistory, [p.po.id, p.po.po_no, "update", "edit_reason", null, p.reason, null, changedBy])

  return { po_no: p.po.po_no, changes: p.changes }
}

/** The staged edit back out of its approval_items: changed fields plus `reason`. */
export function draftEditFromItems(items: { field_name: string; new_value: string }[]): DraftPoEdit {
  const get = (f: string) => items.find((i) => i.field_name === f)
  const edit: DraftPoEdit = { reason: get("reason")?.new_value ?? "" }
  const qty = get("qty")
  if (qty) edit.qty = Number(qty.new_value)
  for (const f of ["expected_on", "destination", "remarks", "mfg_unit"] as const) {
    const it = get(f)
    if (it) edit[f] = it.new_value
  }
  return edit
}
