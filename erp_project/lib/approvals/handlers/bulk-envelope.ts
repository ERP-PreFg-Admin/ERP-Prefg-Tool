/**
 * Shared *_BULK envelope for common S3 parsing, validation,
 * row tracking, event IDs, and success/failure telemetry.
 *
 * Specialized handlers (MFG_MISC_BULK, PO_BULK, BOM_BULK) remain
 * bespoke due to their different processing/error semantics.
 *
 * `prepare` is the only supported optional hook for batch-level setup.
 */

import { ImportRow, parseS3Import } from "@/lib/import-s3"
import { PoolConnection } from "mysql2/promise"
import { ModuleHandler, s3KeyOf } from "./types"
import { makeEventId, recordFailedEvent, recordProcessedEvent } from "@/lib/events"

export type BulkRowCtx = {
    conn : PoolConnection
    entityId: number 
    approverId : number
    raisedBy?:number
}

export type BulkRowOutcome = "inserted" | "skipped"

export function bulkHandler<T = ImportRow> (
    module:string ,
    opts : {
        prepare?: (conn:PoolConnection , rows : ImportRow[]) => Promise<T[]>
        applyRow: (item: T , ctx : BulkRowCtx) => Promise<BulkRowOutcome>
    }
) : ModuleHandler {
    return {
        async setStatus() {
            // No entity exists before approval - nothing to roll back on reject
        } , 
        async applyAndArchive(conn, entityId, items, approverId, raisedBy) {
            const s3Key = s3KeyOf(items , module)
            const rows = await parseS3Import(s3Key)
            if(rows.length === 0) throw new Error(`${module}: file has no data rows`)
            
            const eventId = makeEventId(module , "apply")
            let inserted = 0 
            let skipped = 0
            try {
                const work = opts.prepare ? await opts.prepare(conn , rows) : (rows as unknown as T[])

                for(const item of work) {
                    const outcome = await opts.applyRow(item , {conn , entityId , approverId , raisedBy})
                    if(outcome === "inserted") inserted++
                    else skipped++
                }
                recordProcessedEvent(module , eventId, { s3Key , inserted , skipped})
            } catch(err) {
                recordFailedEvent(module , eventId , { s3Key } , err instanceof Error ? err.message : String(err))
                throw err
            }
        }
    }
}