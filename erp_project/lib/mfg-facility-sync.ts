/**
 * Pull a Vendor Item Master export straight from Unicommerce and apply it.
 *
 * One facility per call. Unicommerce has no endpoint that returns a vendor's
 * catalogue directly — the only route is an asynchronous export job, so this is
 * create → poll → download → parse → upsert, and the whole sequence is per
 * facility because the Facility header is what scopes the report.
 *
 * ── Nothing is kept ──────────────────────────────────────────────────────────
 * The CSV exists only as a string in this function's scope. It is never written to
 * disk, never staged in S3, and never returned to the caller — it is parsed,
 * reduced to the three columns that matter, and dropped when the function returns.
 * There is deliberately nothing to clean up afterwards, which is the only kind of
 * cleanup that cannot be forgotten.
 *
 * Extracted from the route so it can be tested: a route opens its own transaction
 * and cannot be rolled back, per CLAUDE.md.
 */

import { query, execute } from "@/lib/db"
import { parseCsvObjects } from "@/lib/csv"
import { mfgFacilityMap } from "@/lib/queries/mfg-facility-map"
import { inScope, type UserScope } from "@/lib/scope"
import {
  createExportJob, pollExportJob, downloadExportCsv, UniwareFatalError, uniwareEnabled,
} from "@/lib/uniware"
import logger from "@/lib/logger"

/** Rows per INSERT. Keeps one statement from carrying thousands of groups. */
const CHUNK = 500

export type SyncStep =
  | { step: "job"; status: "start" | "ok"; jobCode?: string }
  | { step: "poll"; status: "tick" | "ok"; attempt?: number; jobStatus?: string }
  | { step: "download"; status: "start" | "ok"; rows?: number }
  | { step: "apply"; status: "start" | "ok"; written?: number }

export type SyncEmit = (e: SyncStep) => void | Promise<void>

export type FacilitySyncResult = {
  facility: string
  ok: boolean
  /** Rows in the export before matching. */
  read: number
  /** Mapping rows written or refreshed. */
  written: number
  skipped: Record<string, number>
  error?: string
  /** True when the failure is permanent for this facility — a bad code. Callers
   *  should not retry it. */
  fatal?: boolean
}

/**
 * The columns this import needs, and the header spellings the export uses.
 *
 * Uniware returns DISPLAY names ("Vendor Code"), not the keys we asked for
 * ("vendorCode"), and its own `Facility` column comes back blank on some
 * facilities — so the facility we requested is the reliable value, and the column
 * is only a fallback.
 */
const COLS = {
  vendor_code: ["vendor code", "vendorcode"],
  sku_code: ["product code", "itemtypesku", "item type sku", "item sku code"],
  facility: ["facility", "requested facility"],
}

const pick = (row: Record<string, string>, names: string[]): string => {
  for (const n of names) {
    const v = row[n]
    if (v && v.trim()) return v.trim()
  }
  return ""
}

/**
 * Reduce a downloaded CSV to `{ vendor_code, sku_code }` pairs.
 *
 * `facility` is NOT taken from the file: the export's own column is blank for some
 * facilities, and we already know which one we asked for. Trusting the column would
 * silently attribute a whole facility's catalogue to nowhere.
 *
 * Exported for tests — this is the parsing that a header change would break.
 */
export function extractRows(csv: string): { vendor_code: string; sku_code: string }[] {
  return parseCsvObjects(csv)
    .map((r) => ({ vendor_code: pick(r, COLS.vendor_code), sku_code: pick(r, COLS.sku_code) }))
    .filter((r) => r.vendor_code && r.sku_code)
}

/**
 * Sync one facility end to end.
 *
 * Never throws for a business failure — a bad facility code, a rejected job, an
 * export that contains nothing we recognise are all normal outcomes across 18
 * facilities, and the caller needs the other 17 to continue. The result carries
 * what happened.
 */
export async function syncFacility(
  facilityCode: string,
  userId: number,
  scope: UserScope,
  emit?: SyncEmit,
): Promise<FacilitySyncResult> {
  const out: FacilitySyncResult = {
    facility: facilityCode, ok: false, read: 0, written: 0, skipped: {},
  }
  const skip = (reason: string) => { out.skipped[reason] = (out.skipped[reason] ?? 0) + 1 }

  if (!uniwareEnabled()) {
    out.error = "Uniware is not configured"
    return out
  }

  try {
    await emit?.({ step: "job", status: "start" })
    let jobCode: string
    try {
      jobCode = await createExportJob(facilityCode)
    } catch (err) {
      // The documented fallback: a rejected column list is retried asking for
      // every column. isFatalExportError deliberately does not classify that as
      // fatal, so this branch stays reachable.
      if (err instanceof UniwareFatalError) throw err
      logger.warn({
        module: "MFG_FACILITY_SYNC", facility: facilityCode,
        err: err instanceof Error ? err.message : String(err),
        message: "Named columns rejected; retrying with all columns",
      })
      jobCode = await createExportJob(facilityCode, undefined, [])
    }
    await emit?.({ step: "job", status: "ok", jobCode })

    const filePath = await pollExportJob(jobCode, {
      onTick: (attempt, jobStatus) => { void emit?.({ step: "poll", status: "tick", attempt, jobStatus }) },
    })
    await emit?.({ step: "poll", status: "ok" })

    await emit?.({ step: "download", status: "start" })
    const csv = await downloadExportCsv(filePath)
    const rows = extractRows(csv)
    out.read = rows.length
    await emit?.({ step: "download", status: "ok", rows: rows.length })

    await emit?.({ step: "apply", status: "start" })
    out.written = await applyRows(facilityCode, rows, userId, scope, skip)
    await emit?.({ step: "apply", status: "ok", written: out.written })

    out.ok = true
  } catch (err: unknown) {
    out.error = err instanceof Error ? err.message : String(err)
    out.fatal = err instanceof UniwareFatalError
    logger.warn({
      module: "MFG_FACILITY_SYNC", facility: facilityCode,
      err: out.error, fatal: out.fatal, message: "Facility sync failed",
    })
  }
  // `csv` and `rows` fall out of scope here — nothing persisted, nothing to delete.
  return out
}

/**
 * Resolve and upsert one facility's rows.
 *
 * Three round trips regardless of row count: a facility can carry 28,000 rows and a
 * query each would be unusable.
 *
 * Rows are skipped with a reason rather than failing the import. A real export
 * legitimately contains vendor codes nobody has mapped and ~1,600 items against the
 * ~300 SKUs we hold, so refusing the file on the first would make the button
 * useless. An UNMAPPED VENDOR CODE is never guessed at — that is the signal a
 * manufacturer needs mapping, and fuzzy-matching it can attribute stock to the
 * wrong company.
 */
async function applyRows(
  facilityCode: string,
  rows: { vendor_code: string; sku_code: string }[],
  userId: number,
  scope: UserScope,
  skip: (reason: string) => void,
): Promise<number> {
  if (rows.length === 0) return 0

  const index = await query<{
    wh_id: number; un_mfg_code: string; mfg_id: number
    facility_code: string; wh_name: string
  }>(mfgFacilityMap.vendorCodeIndex, [])
  const byPair = new Map(
    index.filter((r) => r.facility_code === facilityCode).map((r) => [r.un_mfg_code, r])
  )
  if (byPair.size === 0) {
    skip("no manufacturer is mapped to this facility yet")
    return 0
  }

  const codes = [...new Set(rows.map((r) => r.sku_code))]
  const skuRows = await query<{ id: number; sku_code: string; brand_id: number | null }>(
    mfgFacilityMap.skuIdsByCodes, [codes]
  )
  const bySku = new Map(skuRows.map((r) => [r.sku_code, r]))

  const params: (string | number | Date)[] = []
  const seen = new Set<string>()
  const seenAt = new Date()
  let written = 0

  for (const row of rows) {
    const pair = byPair.get(row.vendor_code)
    if (!pair) { skip("unmapped vendor code at this facility"); continue }
    if (!inScope(scope, "mfg", pair.mfg_id)) { skip("manufacturer out of your scope"); continue }
    if (!inScope(scope, "warehouse", pair.wh_name)) { skip("warehouse out of your scope"); continue }

    const sku = bySku.get(row.sku_code)
    if (!sku) { skip("SKU not in the SKU master"); continue }
    // inScope passes a null id, which matches assertBrand: unattributed is allowed.
    if (!inScope(scope, "brand", sku.brand_id)) { skip("SKU brand out of your scope"); continue }

    // One export can repeat a SKU across sub-rows. A duplicate key inside ONE
    // multi-row upsert is applied twice by MySQL rather than erroring, so dedupe here.
    const key = `${pair.mfg_id}:${pair.wh_id}:${sku.id}`
    if (seen.has(key)) { skip("duplicate row in the export"); continue }
    seen.add(key)

    params.push(pair.mfg_id, pair.wh_id, sku.id, pair.un_mfg_code, seenAt, userId, userId)
    written++
  }

  for (let i = 0; i < written; i += CHUNK) {
    const n = Math.min(CHUNK, written - i)
    await execute(mfgFacilityMap.buildRecordSeen(n), params.slice(i * 7, (i + n) * 7))
  }
  return written
}
