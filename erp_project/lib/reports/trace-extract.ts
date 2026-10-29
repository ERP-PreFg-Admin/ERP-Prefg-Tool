// Nightly traceability feed: every dataset as a CSV (contract keys as headers) plus manifest.json, written to
// reports/daily/<APP_ENV>/<IST date>/ in the files bucket. Unscoped by decision (docs/reporting/traceability-plan.md):
// no DB row owns these keys, so assertKeyReadable refuses them through the app's file routes.

import { buildCsv } from "@/lib/export"
import { uploadFile } from "@/lib/s3"
import { APP_ENV, TRACE_EXTRACT_ENABLED } from "@/lib/env"
import { todayIST } from "@/lib/date"
import logger from "@/lib/logger"
import { UNRESTRICTED } from "@/lib/scope"
import { TRACE_CONTRACT_VERSION, TRACE_DATASETS, TRACE_TABS } from "@/lib/reports/trace/contracts"
import type { TraceQuery } from "@/lib/reports/trace/params"
import { datasetRows, exportColumns } from "@/lib/services/reports/trace/export"

export const traceExtractPrefix = (day: string) => `reports/daily/${APP_ENV}/${day}/`

const ALL: TraceQuery = {
  tab: "t1", status: null, byMonth: false,
  filters: { mfgCode: null, skuCode: null, poNo: null, invoiceNo: null, batchKey: null, dateFrom: null, dateTo: null },
}

export async function runTraceExtract(): Promise<{ skipped: true } | { prefix: string; rows: Record<string, number> }> {
  if (!TRACE_EXTRACT_ENABLED) return { skipped: true }
  const prefix = traceExtractPrefix(todayIST())
  const rows: Record<string, number> = {}

  for (const tab of TRACE_TABS) {
    const ds = TRACE_DATASETS[tab]
    const data = await datasetRows(UNRESTRICTED, tab, { ...ALL, tab })
    await uploadFile(Buffer.from(buildCsv(exportColumns(tab, "key"), data), "utf8"), `${prefix}${ds.file}.csv`, "text/csv")
    rows[ds.file] = data.length
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    contract: TRACE_CONTRACT_VERSION,
    app_env: APP_ENV,
    scope: "unrestricted",
    datasets: TRACE_TABS.map((t) => ({
      file: `${TRACE_DATASETS[t].file}.csv`, name: TRACE_DATASETS[t].name, grain: TRACE_DATASETS[t].grain,
      rows: rows[TRACE_DATASETS[t].file], columns: TRACE_DATASETS[t].columns.map((c) => c.key),
    })),
  }
  await uploadFile(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), `${prefix}manifest.json`, "application/json")
  logger.info({ module: "CRON", message: "trace extract written", prefix, rows })
  return { prefix, rows }
}
