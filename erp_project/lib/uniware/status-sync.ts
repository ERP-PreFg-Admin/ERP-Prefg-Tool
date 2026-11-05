import { execute, query } from "../db";
import logger from "../logger";
import { supplierInvoicesSql  } from "../queries/supplier-invoices";
import { uniwareGrn } from "../queries/uniware-grn";
import { uniwareEnabled } from "./auth";
import { requireFacilityForInvoice } from "./facility-resolve";
import { syncGrnsForInvoice } from "./grn-sync";
import { fetchPurchaseOrderStatus } from "./purchase-order";

/* One request per PO. */
export const  MAX_PER_RUN = 150 ;
/* As GRN is N+1 calls each, so they get a smaller budget */
const GRN_BUDGET = 25

export type StatusSyncRow = {
    id: number
    uniware_po_code: string
    destination: string | null
    buyer_gstin: string | null
}

export async function runStatusSync(rows: StatusSyncRow[] , ctx: Record<string , unknown> ={}) {
    const truncated = rows.length > MAX_PER_RUN
    const batch = truncated ? rows.slice(0, MAX_PER_RUN) : rows

    let synced = 0
    let receipts = 0
    let unmatchedLines = 0
    let grnBudget = GRN_BUDGET
    let grnDeferred = 0
    let cancelled = 0 
    const failures : { code: string , error : string} [] = []

    for(const row of batch) {
        try {
            const facility = await requireFacilityForInvoice(row)
            const { status , grnCount , lines} = await fetchPurchaseOrderStatus(row.uniware_po_code , facility)
            await execute(supplierInvoicesSql.setUniwareStatus , [status , row.id])
            await execute(uniwareGrn.setGrnCount , [grnCount , row.id])

            if(String(status).toUpperCase() === "CANCELLED") {
                const res = await execute(uniwareGrn.cancelInwardPosByUniwareCode , [row.uniware_po_code])
                if(res.affectedRows > 0) {
                    cancelled+=res.affectedRows
                    logger.info({ ...ctx, poCode: row.uniware_po_code, inwardPos: res.affectedRows,
                        message: "Uniware cancelled this PO — cancelled our inward POs for it" })
                }
            }

            for(const l of lines) {
                await execute(uniwareGrn.setUniwareLineQty ,[l.pendingQty, l.qcPassQty, row.uniware_po_code, l.sku])
            }
            synced++
            if(grnCount > 0) {
                if(grnBudget > 0) {
                    grnBudget--
                    try {
                        const one = await syncGrnsForInvoice(row, facility)
                        receipts += one.receipts
                        unmatchedLines += one.unmatchedLines
                    } catch(err) {
                        const error = err instanceof Error ? err.message : String(err)
                        failures.push({ code: `${row.uniware_po_code} (receipts)`, error })
                        logger.warn({ ...ctx, poCode: row.uniware_po_code, err: error,
                            message: "Uniware receipt sync failed for one PO" })
                    }
                }
                else {
                    grnDeferred++
                }
            }
        }catch(err) {
            const error = err instanceof Error ? err.message : String(err)
            failures.push({ code: row.uniware_po_code, error })
            logger.warn({ ...ctx, poCode: row.uniware_po_code, err: error,
                message: "Uniware status sync failed for one PO" })
        }
    }

    if(unmatchedLines > 0) {
        logger.warn({ ...ctx, unmatchedLines, message: "Uniware Sync found unmatched lines" })
    }

    return {
        total: batch.length, synced, failed: failures.length, failures: failures.slice(0, 10),
        truncated, limit: MAX_PER_RUN, receipts, grnDeferred, cancelled, unmatchedLines,
    }
}

export async function runScheduledStatusSync(ctx: Record<string, unknown>) {
  if (!uniwareEnabled()) return { skipped: "uniware_unconfigured" }
  const rows = await query<StatusSyncRow>(supplierInvoicesSql.selectAllForStatusSync, [MAX_PER_RUN + 1])
  return runStatusSync(rows, ctx)
}