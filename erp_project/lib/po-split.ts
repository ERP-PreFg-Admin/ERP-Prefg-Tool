// Splitting a PO into child POs.
//
// Extracted from app/api/v1/purchase-orders/[id]/split/route.ts for the same reason
// receiving was extracted into lib/po-receive.ts: the quantity math is the part
// that must not drift, and inline in a route handler it is unreachable from a
// test without standing up an HTTP server.
//
// Behaviour is unchanged from the inline version. The decisions are pure
// functions; splitPo() does the writes and takes an already-open connection —
// it does NOT begin/commit/rollback, because the route owns the transaction
// (MySQL implicitly commits on a nested BEGIN, see CLAUDE.md).

import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { approvalsSql } from "@/lib/queries/approvals"
import { ApiError } from "@/lib/gateway/errors"
import { poTolerance } from "@/lib/po-rules"
import { RECEIVABLE } from "@/lib/po-receive"

/** Statuses a PO can still be split from. A received/cancelled order cannot. */
export const SPLITTABLE = new Set(["draft", "raised", "punched", "partially_received"])

export type SplitParentPo = {
  id: number
  po_no: string
  mfg_id: number
  sku_code: string | null
  /** Inherited by every child — a split divides one order, it doesn't raise a
   *  new one, so a child must not pick up a Recipe version the parent never had. */
  recipe_id: number | null
  qty: number | string
  unit_price: number | string | null
  /** Needed to scale the parent's value when unit_price is NULL. */
  total_amount?: number | string | null
  received_qty: number | string | null
  expected_on: string | Date | null
  status: string
}

export type SplitRow = {
  mfg_id: number
  destination?: string | null
  qty: number | string
}

export type SplitResult = {
  children: { id: number; po_no: string; qty: number; status: string }[]
  newQty: number
  newTotalAmount: number | null
  approvalIds: number[]
  /** True when reducing qty brought the parent within tolerance and it was closed. */
  parentClosed: boolean
}

/** Ordered qty not yet received — the ceiling on what can be split off. */
export function remainingQty(po: Pick<SplitParentPo, "qty" | "received_qty">): number {
  return Number(po.qty) - Number(po.received_qty ?? 0)
}

export function splitTotalOf(splits: SplitRow[]): number {
  return splits.reduce((sum, s) => sum + Number(s.qty), 0)
}

/** `PO-123-S001`, `-S002`, … by position in the sequence. */
export function childPoNo(parentPoNo: string, index: number): string {
  return `${parentPoNo}-S${String(index + 1).padStart(3, "0")}`
}

/**
 * The highest `-S###` suffix already used by this parent's children.
 *
 * A repeat split must continue the sequence. Numbering from the position within
 * the current request restarts at -S001 every time, and `purchase_orders.po_no`
 * is UNIQUE, so a second split of the same PO used to fail outright with
 * ER_DUP_ENTRY.
 *
 * Uses MAX rather than COUNT so a deleted child can't cause the sequence to
 * re-issue a number that is still in use elsewhere.
 */
export function highestChildSuffix(parentPoNo: string, childPoNos: string[]): number {
  const prefix = `${parentPoNo}-S`
  let max = 0
  for (const poNo of childPoNos) {
    if (!poNo.startsWith(prefix)) continue
    const seq = Number.parseInt(poNo.slice(prefix.length), 10)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}

async function nextChildIndex(conn: PoolConnection, parentPoNo: string): Promise<number> {
  const [rows] = await conn.execute(purchaseOrdersSql.selectChildPoNos, [parentPoNo])
  const poNos = (rows as { po_no: string }[]).map((r) => r.po_no)
  return highestChildSuffix(parentPoNo, poNos)
}

/**
 * The parent's qty and total after the split.
 *
 * `total_amount` follows `unit_price` where there is one. Where there isn't, the
 * existing total is scaled by the quantity that remains — multiplying by a
 * missing unit price used to silently zero the PO's value. A parent with neither
 * a unit price nor a total keeps NULL rather than acquiring a fabricated 0.
 */
export function parentAfterSplit(
  po: Pick<SplitParentPo, "qty" | "unit_price" | "total_amount">,
  splitTotal: number
): { newQty: number; newTotalAmount: number | null } {
  const oldQty = Number(po.qty)
  const newQty = oldQty - splitTotal

  if (po.unit_price != null) {
    return { newQty, newTotalAmount: newQty * Number(po.unit_price) }
  }
  if (po.total_amount != null && oldQty > 0) {
    // Proportional: the implied per-unit value is preserved.
    return { newQty, newTotalAmount: (Number(po.total_amount) * newQty) / oldQty }
  }
  return { newQty, newTotalAmount: null }
}

/**
 * Whether reducing the parent to `newQty` leaves it complete.
 *
 * Split deliberately doesn't touch `received_qty` — but shrinking `qty` can still
 * finish an order, and nothing used to re-check that. The read-side status
 * expression only derives `partially_received` while `received_qty < qty`, so a
 * parent left at received >= qty read as `raised` forever: still in the open tab,
 * still offered as a receipt target, and impossible to receive against.
 *
 * Reuses poTolerance so there is exactly one closing rule shared with receiving.
 */
export function closesParent(po: Pick<SplitParentPo, "received_qty" | "status">, newQty: number): boolean {
  const received = Number(po.received_qty ?? 0)
  // Nothing received means nothing arrived — a fully split-away order is empty,
  // not fulfilled. And only an open, receivable status can close this way.
  if (received <= 0 || !RECEIVABLE.has(po.status)) return false
  return newQty - received <= poTolerance(newQty)
}

/** Throws the 400/409 the route used to throw inline. */
export function assertSplittable(po: SplitParentPo, splits: SplitRow[]): void {
  if (!SPLITTABLE.has(po.status)) {
    throw new ApiError(
      409,
      "not_splittable",
      `Cannot split a PO with status '${po.status}'. Allowed: draft, raised, punched, partially_received.`
    )
  }
  const remaining = remainingQty(po)
  const splitTotal = splitTotalOf(splits)
  if (splitTotal > remaining) {
    throw new ApiError(400, "over_limit", `Split total (${splitTotal}) exceeds remaining qty (${remaining}).`)
  }
}

/**
 * Insert the child POs and reduce the parent.
 *
 * `mfgLabels` maps mfg_id to the human label used in a draft child's approval
 * diff; the caller pre-fetches it so this function does no lookups of its own.
 *
 * The parent's `status` and `received_qty` are deliberately untouched — a split
 * is not a receiving event.
 */
export async function splitPo(
  conn: PoolConnection,
  po: SplitParentPo,
  splits: SplitRow[],
  userId: number,
  mfgLabels: Record<number, { code: string; name: string }>
): Promise<SplitResult> {
  assertSplittable(po, splits)

  const isParentDraft = po.status === "draft"
  const childStatus = isParentDraft ? "draft" : "raised"
  const children: SplitResult["children"] = []
  const approvalIds: number[] = []
  // Continue the existing sequence rather than restarting at -S001.
  const startIndex = await nextChildIndex(conn, po.po_no)

  for (let i = 0; i < splits.length; i++) {
    const { mfg_id, destination, qty } = splits[i]
    const poNo = childPoNo(po.po_no, startIndex + i)
    const mfg = mfgLabels[mfg_id] ?? { code: String(mfg_id), name: String(mfg_id) }

    const [childResult] = await conn.execute<ResultSetHeader>(
      purchaseOrdersSql.insertSplit,
      [poNo, mfg_id, po.sku_code, Number(qty), po.expected_on, childStatus, destination || null, po.po_no,
       po.recipe_id ?? null, mfg_id, po.sku_code]
    )
    const childId = childResult.insertId
    children.push({ id: childId, po_no: poNo, qty: Number(qty), status: childStatus })

    // A child of a draft parent hasn't been approved yet, so it needs its own
    // approval record; a child of an already-raised PO inherits that approval.
    if (isParentDraft) {
      const [ar] = await conn.execute<ResultSetHeader>(
        approvalsSql.insertApproval,
        [userId, "PO", childId, "create"]
      )
      approvalIds.push(ar.insertId)
      // `expected_on` is passed through as-is (a Date from mysql2, or null) and
      // left for the driver to format, exactly as the inline version did —
      // String()-ing it here would store a different value in approval_items.
      const items: [string, string, string | Date | null][] = [
        ["po_no",        "", poNo],
        ["manufacturer", "", `${mfg.code} — ${mfg.name}`],
        ["sku_code",     "", po.sku_code],
        ["qty",          "", String(qty)],
        ["expected_on",  "", po.expected_on || ""],
        ["destination",  "", destination || ""],
        ["split_from",   "", po.po_no],
      ]
      for (const [field, oldVal, newVal] of items) {
        await conn.execute(approvalsSql.insertApprovalItem, [ar.insertId, field, oldVal, newVal])
      }
    }
  }

  const { newQty, newTotalAmount } = parentAfterSplit(po, splitTotalOf(splits))
  await conn.execute(purchaseOrdersSql.setQtyAndTotalAfterSplit, [newQty, newTotalAmount, po.id])

  // Shrinking qty can complete an order that was still short. `received_qty` is
  // untouched either way — a split is not a receiving event.
  const parentClosed = closesParent(po, newQty)
  if (parentClosed) {
    await conn.execute(purchaseOrdersSql.setStatus, ["received", po.id])
  }

  return { children, newQty, newTotalAmount, approvalIds, parentClosed }
}
