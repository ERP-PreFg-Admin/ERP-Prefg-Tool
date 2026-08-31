/**
 * Pull Unicommerce's inflow receipts (GRNs) for every mirrored PO into
 * grn_uniware / grn_items_uniware.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * This NEVER writes to purchase_orders. received_qty is our record of what the
 * invoice claimed (written by lib/po/po-receive.ts at commit time); a GRN is the
 * warehouse's record of what it accepted. They will disagree, and the
 * disagreement is the entire point of this feature — "reconciling" them here
 * would destroy the signal on the first run. Reconciliation is derived at read
 * time; see lib/uniware/grn-totals.ts.
 *
 * ── WHY THIS IS A CALLABLE AND NOT A ROUTE HANDLER ───────────────────────────
 * The route is a thin wrapper over runGrnSync(). Sync is a manual button today
 * and a scheduled sweep later; keeping the work here means the scheduler calls
 * the same code path rather than a second copy that drifts.
 *
 * ── NEVER THROW FOR ONE PO ───────────────────────────────────────────────────
 * Same shape as pushPurchaseOrders and the status sync: a tenant that 500s on
 * one code, an unmapped destination, or a receipt whose shape we don't recognise
 * must not cost the caller the other forty-nine answers. Each is reported.
 *
 * That matters more here than elsewhere, because grn-map.ts is deliberately
 * STRICT — an unexpected field name throws instead of reading as zero. This is
 * what makes that safe: the failure is loud, attributed to its PO, and contained.
 */

import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { uniwareGrn } from "@/lib/queries/uniware-grn"
import { requireFacilityForInvoice } from "./facility-resolve"
import { fetchGrnsForPo } from "./grn"
import type { Grn } from "./grn-map"
import logger from "@/lib/logger"

/**
 * ponytail: a flat cap, like the status sync's. Lower than its 150 because GRNs
 * are 1+N calls per PO where a status check is 1 — a PO with four receipts costs
 * five round trips. When the mirrored set outgrows this the answer is the
 * scheduled sweep, not a bigger number. What it cut off is reported, never
 * silently dropped.
 */
export const MAX_PER_RUN = 40

type InvoiceRow = {
  id: number
  uniware_po_code: string
  destination: string | null
  buyer_gstin: string | null
  uniware_grn_count: number | null
}

export type GrnSyncResult = {
  total: number
  /** Invoices we successfully asked about — including those with no receipts. */
  synced: number
  /** Receipts written or refreshed. */
  receipts: number
  /** Receipt lines that matched no inward PO of ours — a finding, not an error. */
  unmatchedLines: number
  failed: number
  failures: { code: string; error: string }[]
  truncated: boolean
  limit: number
}

/**
 * Write one receipt and its lines.
 *
 * One transaction per receipt, not per sweep: a sweep spans dozens of Uniware
 * round trips and holding a transaction across them would pin a connection for
 * minutes. A receipt is the unit that must be all-or-nothing — its header totals
 * and its lines have to agree.
 *
 * Per CLAUDE.md, beginTransaction/commit/rollback live here at the top of the
 * write, never inside the helpers this calls.
 */
async function storeGrn(
  grn: Grn,
  // The two fields a receipt is filed under. Same narrow shape as
  // syncGrnsForInvoice's, so both callers of that can pass their own row type.
  invoice: { id: number; uniware_po_code: string },
  facility: string | undefined,
  poBySku: Map<string, number>
): Promise<{ unmatched: number }> {
  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()
  try {
    const [res] = await conn.execute(uniwareGrn.upsertGrn, [
      grn.grnCode,
      invoice.uniware_po_code,
      invoice.id,
      facility ?? null,
      grn.statusCode,
      grn.vendorInvoiceNo,
      grn.createdAt,
      grn.totalQty,
      grn.totalRejectedQty,
      JSON.stringify(grn),
    ])
    // LAST_INSERT_ID(id) in the ON DUPLICATE KEY branch makes insertId correct
    // on a re-sync too, not just on a first insert.
    const grnId = (res as { insertId: number }).insertId

    // Replace, don't upsert: line_no is positional, so a receipt amended in
    // Uniware to drop a line would otherwise keep it as a phantom that still
    // counts toward the totals.
    await conn.execute(uniwareGrn.deleteGrnItems, [grnId])

    let unmatched = 0
    for (const item of grn.items) {
      const poId = item.skuCode ? poBySku.get(item.skuCode) ?? null : null
      if (poId == null) unmatched++
      await conn.execute(uniwareGrn.insertGrnItem, [
        grnId, item.lineNo, item.skuCode, poId,
        item.quantity, item.rejectedQty,
        item.batchCode, item.expiry, item.mfgDate,
      ])
    }

    await conn.commit()
    return { unmatched }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Pull and store every receipt for ONE mirrored invoice.
 *
 * Extracted so the status sync can call it inline: that pass already learns
 * `inflowReceiptsCount` from the same getPurchaseOrderDetails call it makes for
 * the status, so it knows for free which POs have receipts and can walk only
 * those. Doing it there means "Sync Uniware" is one button that leaves both the
 * status and the receipts current, instead of two the user has to remember to
 * press in order.
 *
 * Throws on failure — every caller already has a per-invoice catch, and a
 * receipt whose shape we don't recognise must be loud (see grn-map.ts).
 */
export async function syncGrnsForInvoice(
  // Only what the walk actually reads. Narrower than InvoiceRow on purpose: the
  // status sync's own row type carries neither uniware_grn_count nor anything
  // else here, and demanding fields this never touches would force a caller to
  // invent them.
  invoice: { id: number; uniware_po_code: string },
  facility: string | undefined
): Promise<{ receipts: number; unmatchedLines: number }> {
  const grns = await fetchGrnsForPo(invoice.uniware_po_code, facility)

  let receipts = 0
  let unmatchedLines = 0

  // No receipts is the normal state of a PO nothing has arrived against.
  if (grns.length > 0) {
    // One lookup per invoice, reused across its receipts. The 1:1 join holds
    // only because mergeInwardLinesBySku raises one inward PO per SKU.
    const poRows = await query<{ id: number; sku_code: string }>(
      uniwareGrn.selectInwardPosByUniwareCode,
      [invoice.uniware_po_code]
    )
    const poBySku = new Map(poRows.map((p) => [p.sku_code, p.id]))

    for (const grn of grns) {
      const { unmatched } = await storeGrn(grn, invoice, facility, poBySku)
      receipts++
      unmatchedLines += unmatched
    }
  }

  // Keep the stored count honest with what we just saw, so the next sweep's
  // filter reflects reality even if the status pass has not run since.
  await query(uniwareGrn.setGrnCount, [grns.length, invoice.id])
  return { receipts, unmatchedLines }
}

export async function runGrnSync(
  ctx: Record<string, unknown> = {},
  limit = MAX_PER_RUN
): Promise<GrnSyncResult> {
  const rows = await query<InvoiceRow>(uniwareGrn.selectForGrnSync, [limit + 1])
  const truncated = rows.length > limit
  const batch = truncated ? rows.slice(0, limit) : rows

  let synced = 0
  let receipts = 0
  let unmatchedLines = 0
  const failures: { code: string; error: string }[] = []

  for (const invoice of batch) {
    try {
      const facility = await requireFacilityForInvoice(invoice)
      const one = await syncGrnsForInvoice(invoice, facility)
      receipts += one.receipts
      unmatchedLines += one.unmatchedLines
      synced++
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ code: invoice.uniware_po_code, error })
      logger.warn({
        ...ctx, poCode: invoice.uniware_po_code, err: error,
        message: "Uniware GRN sync failed for one PO",
      })
    }
  }

  if (unmatchedLines > 0) {
    // Worth a log line of its own: it means the warehouse received a SKU we
    // never raised a PO for, which no failure count would surface.
    logger.warn({
      ...ctx, unmatchedLines,
      message: "GRN lines matched no inward PO — receipts for SKUs we did not raise",
    })
  }

  return {
    total: batch.length,
    synced,
    receipts,
    unmatchedLines,
    failed: failures.length,
    // Capped at 10: this feeds a toast, not a report. `failed` is the real count.
    failures: failures.slice(0, 10),
    // Named so the UI can say so — a silent cap reads as "everything is synced".
    truncated,
    limit,
  }
}
