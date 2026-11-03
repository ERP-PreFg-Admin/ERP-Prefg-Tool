// Row locks for any write that changes a PO's quantity or status. Lock order is
// always parent first, then its splits by id — every writer must follow it, or two of them can deadlock.

import type { PoolConnection } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { cancelBlock, closeBlock, type SplitRow } from "@/lib/po/po-rules"

export type LockedPo = {
  id: number
  po_no: string
  mfg_id: number
  sku_code: string | null
  recipe_id: number | null
  destination: string | null
  status: string
  email_sent_at: Date | null
  po_type: string | null
  reference_po: string | null
  qty: string
  received_qty: string
}

export type LockedFamily = {
  po: LockedPo
  /** This PO's own splits, every status. Empty for a split itself. */
  splits: (SplitRow & { id: number })[]
}

/** Locks a PO and its order. Takes the caller's transaction; never begins or commits. */
export async function lockPoFamily(conn: PoolConnection, poId: number): Promise<LockedFamily> {
  const [keyRows] = await conn.execute(purchaseOrdersSql.selectFamilyKey, [poId])
  const key = (keyRows as { po_no: string; parent_po_no: string | null }[])[0]
  if (!key) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

  if (key.parent_po_no) await conn.execute(purchaseOrdersSql.lockByPoNo, [key.parent_po_no])
  const [poRows] = await conn.execute(purchaseOrdersSql.selectFamilyMemberLocked, [poId])
  const po = (poRows as LockedPo[])[0]
  if (!po) throw new ApiError(404, "not_found", `PO id=${poId} not found`)

  if (key.parent_po_no) return { po, splits: [] }
  const [splitRows] = await conn.execute(purchaseOrdersSql.selectSplitsLocked, [po.po_no])
  return { po, splits: splitRows as LockedFamily["splits"] }
}

/** Locks the order and says why it can't move to `to`, or null. */
export async function terminalBlock(
  conn: PoolConnection,
  poId: number,
  to: "short_closed" | "cancelled",
): Promise<{ po: LockedPo; blocked: string | null }> {
  const { po, splits } = await lockPoFamily(conn, poId)
  return { po, blocked: to === "short_closed" ? closeBlock(po, splits) : cancelBlock(po, splits) }
}

/** Short-close or cancel under lock, re-checking the rules on the locked rows. */
export async function setTerminalStatus(
  conn: PoolConnection,
  poId: number,
  to: "short_closed" | "cancelled",
  userId: number,
): Promise<LockedPo> {
  const { po, blocked } = await terminalBlock(conn, poId, to)
  if (blocked) throw new ApiError(409, to === "short_closed" ? "not_closeable" : "not_cancellable", blocked)
  await conn.execute(purchaseOrdersSql.setStatus, [to, po.id])
  await conn.execute(purchaseOrdersSql.insertPoHistory, [po.id, po.po_no, "update", "status", po.status, to, null, userId])
  return po
}
