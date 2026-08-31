/**
 * Pull one facility's Sale Orders export from Unicommerce, then answer both
 * questions from it: the package-type summary, and the gatepass that would be
 * created.
 *
 * One facility per call, because an export is an asynchronous job per facility
 * (create → poll → download) and the Facility header is what scopes it. The same
 * shape as lib/mfg-facility-sync.ts, for the same reason.
 *
 * **One job covers the whole date range.** The range is a single `dateRange` on
 * one export job, not a job per day — a 27-day window costs the same one job as
 * a single day, only a bigger CSV.
 *
 * **One download feeds both answers.** The summary and the gatepass plan are
 * built from the same parsed rows. Planning in a second request would mean a
 * second export job per facility — tens of seconds each, for data just held.
 *
 * ── Nothing is kept ─────────────────────────────────────────────────────────
 * The CSV exists only as a string in this function's scope. Never written to
 * disk, never staged in S3, never returned — parsed, reduced to counts, and
 * dropped when the function returns. There is deliberately nothing to clean up
 * afterwards, which is the only kind of cleanup that cannot be forgotten.
 */

import {
  createExportJob, pollExportJob, downloadExportCsv,
  SALE_ORDER_EXPORT, UniwareFatalError, uniwareEnabled,
} from "@/lib/uniware"
import {
  summariseRows, parseExportRows, istRangeMs, type PackageTypeRow,
} from "./summary"
import { planFacility, type GatepassPlan } from "./plan"
import { toPartyFor } from "./facilities"
import logger from "@/lib/logger"

/**
 * The columns we ask for, by API key. Verified against the live tenant on
 * 2026-08-28 — Uniware rejects an unknown key outright ("invalid column type")
 * and rejects an empty list for this report, so these cannot be guessed.
 *
 * It answers with DISPLAY names ("Display Order Code") and adds columns of its
 * own ("Channel Shipping", "Item Details"), which is why every reader keys on
 * the header name rather than position.
 *
 * `invoiceCreated` is the INVOICE date and is IST-local — the same moment the
 * `invoicedOn` filter selects on. `created` (order placement) and `dispatchDate`
 * also exist and are different moments; picking either would group the rows by a
 * date the filter never used.
 *
 * `skuCode` was requested for a while when lines were built per SKU — add it back
 * here (and re-add `COLS.sku_code`) if the document ever needs a picking list.
 */
const SALE_ORDER_COLUMNS = ["displayorderCode", "shippingPackageTypeCode", "invoiceCreated"]

/** The Sale Orders filter that bounds the export. Confirmed: this is invoice date. */
const INVOICED_ON = "invoicedOn"

export type GatepassStep =
  | { step: "job"; status: "start" | "ok"; jobCode?: string }
  | { step: "poll"; status: "tick" | "ok"; attempt?: number; jobStatus?: string }
  | { step: "download"; status: "start" | "ok"; rows?: number }

export type GatepassEmit = (e: GatepassStep) => void | Promise<void>

export type FacilitySummary = {
  facility: string
  from: string
  to: string
  ok: boolean
  /** Export rows before deduplication — line items, not orders. */
  rows: number
  summary: PackageTypeRow[]
  /** What a gatepass for this facility would carry. Null when the export failed. */
  plan: GatepassPlan | null
  error?: string
  /** Permanent for this facility (a bad code, no access). Callers should not retry. */
  fatal?: boolean
}

/**
 * Summarise one facility over an inclusive IST date range.
 *
 * Never throws for a business failure. A rejected job, a facility the account
 * cannot see, an export with an unfamiliar header — all are normal outcomes
 * across twenty facilities, and the caller needs the other nineteen to continue.
 * The result carries what happened, exactly as `syncFacility` does.
 */
export async function fetchFacilitySummary(
  facility: string,
  from: string,
  to: string,
  emit?: GatepassEmit,
): Promise<FacilitySummary> {
  const out: FacilitySummary = {
    facility, from, to, ok: false, rows: 0, summary: [], plan: null,
  }

  if (!uniwareEnabled()) {
    out.error = "Uniware is not configured"
    return out
  }

  try {
    const dateRange = istRangeMs(from, to)

    await emit?.({ step: "job", status: "start" })
    const jobCode = await createExportJob(
      facility, SALE_ORDER_EXPORT, SALE_ORDER_COLUMNS,
      [{ id: INVOICED_ON, dateRange }],
    )
    await emit?.({ step: "job", status: "ok", jobCode })

    const filePath = await pollExportJob(jobCode, {
      onTick: (attempt, jobStatus) => {
        void emit?.({ step: "poll", status: "tick", attempt, jobStatus })
      },
    })
    await emit?.({ step: "poll", status: "ok" })

    await emit?.({ step: "download", status: "start" })
    const csv = await downloadExportCsv(filePath)

    // Parsed once, read twice.
    const rows = parseExportRows(csv)
    out.rows = rows.length
    out.summary = summariseRows(rows, facility)
    // The plan's lines ARE the summary — one box count per package type — so it
    // is passed in rather than recomputed from the rows.
    out.plan = planFacility(rows, out.summary, facility, { toParty: toPartyFor(facility) })
    await emit?.({ step: "download", status: "ok", rows: out.rows })

    out.ok = true
  } catch (err: unknown) {
    out.error = err instanceof Error ? err.message : String(err)
    out.fatal = err instanceof UniwareFatalError
    logger.warn({
      module: "GATEPASS", facility, from, to,
      err: out.error, fatal: out.fatal, message: "Gatepass summary failed",
    })
  }
  // `csv` and `rows` fall out of scope here — nothing persisted, nothing to delete.
  return out
}
