/**
 * The 08:00 IST low open-PO alert. A callable, like the digest, so the cron
 * runner needs no session.
 */

import { query } from "@/lib/db"
import { todayIST } from "@/lib/date"
import logger from "@/lib/logger"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { sendLowOpenPoEmail } from "@/lib/mail/mailer"
import {
  classify, renderLowOpenPo, OPEN_QTY_THRESHOLD,
  type LowOpenRow, type RowState,
} from "./low-open-po-html"

export type LowOpenResult = { day: string; rows: number; sent: boolean; ms: number }

export async function buildLowOpenRows(
  now = Date.now(),
  /** Override for tuning against real data — see scripts/_check-low-open-po.ts. */
  threshold = OPEN_QTY_THRESHOLD
): Promise<(LowOpenRow & { state: RowState })[]> {
  const rows = await query<Record<string, unknown>>(purchaseOrdersSql.lowOpenByMfg, [threshold])
  return rows.map((r) => {
    const last = (r.last_receipt_at as Date | null) ?? null
    return {
      sku_code: String(r.sku_code),
      sku_name: (r.sku_name as string | null) ?? null,
      mfg_code: String(r.mfg_code),
      mfg_name: String(r.mfg_name),
      // SUM() returns DECIMAL, which mysql2 hands back as a string.
      open_qty: Number(r.open_qty ?? 0),
      open_pos: Number(r.open_pos ?? 0),
      earliest_expected: (r.earliest_expected as Date | null) ?? null,
      last_receipt_at: last,
      state: classify(last, now),
    }
  })
}

export async function runLowOpenReport(
  ctx: Record<string, unknown> = {},
  threshold = OPEN_QTY_THRESHOLD
): Promise<LowOpenResult> {
  const started = Date.now()
  const day = todayIST()
  const rows = await buildLowOpenRows(started, threshold)

  // No mail when there is nothing to chase — a daily empty alert trains people
  // to ignore the one that matters.
  if (rows.length === 0) {
    logger.info({ ...ctx, day, threshold, message: "No pair under the open-PO threshold — not sent" })
    return { day, rows: 0, sent: false, ms: Date.now() - started }
  }

  const sent = await sendLowOpenPoEmail(day, renderLowOpenPo(day, rows, threshold))
  const ms = Date.now() - started
  logger.info({ ...ctx, day, rows: rows.length, sent, ms, message: "Low open PO alert finished" })
  return { day, rows: rows.length, sent, ms }
}
