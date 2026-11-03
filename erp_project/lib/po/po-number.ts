// PO numbers from the serial table: `${prefix}-NNN`, one series per prefix.

import type { PoolConnection } from "mysql2/promise"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { monthIST } from "@/lib/date"
import { nextSerial, seedFrom } from "@/lib/serials"

/** `${brand}-${tag}-YYYYMM` in IST, the same month the inward numbers use. */
export const poPrefix = (brand: string, tag: "PO" | "IMP" | "INW", at = new Date()) =>
  `${brand}-${tag}-${monthIST(at).replace("-", "")}`

/** The next PO number under a prefix; first use carries on from the highest one already issued. */
export async function nextPoNo(conn: PoolConnection, prefix: string): Promise<string> {
  const n = await nextSerial(conn, `PO:${prefix}`, seedFrom(conn, purchaseOrdersSql.lastSeqByPrefix, [`${prefix}-%`]))
  return `${prefix}-${String(n).padStart(3, "0")}`
}

/** The next split of a parent: `${parent}-S001`… `seenMax` is the highest suffix already on its splits. */
export async function nextSplitNo(conn: PoolConnection, parentPoNo: string, seenMax: number): Promise<string> {
  const n = await nextSerial(conn, `SPLIT:${parentPoNo}`, async () => seenMax)
  return `${parentPoNo}-S${String(n).padStart(3, "0")}`
}
