// Traceability files: one dataset as CSV/Excel, or the whole workbook. Shared by the download route and the
// nightly S3 feed. CSV headers are the stable contract keys; Excel headers are the labels (Read-me maps them).

import type { UserScope } from "@/lib/scope"
import { buildCsv, buildMultiSheetXlsx, type ExportColumn } from "@/lib/export"
import { ApiError } from "@/lib/gateway/errors"
import { formatDateTimeIST } from "@/lib/date"
import { TRACE_CAVEATS, TRACE_CONTRACT_VERSION, TRACE_DATASETS, type TraceTab } from "@/lib/reports/trace/contracts"
import type { TraceQuery } from "@/lib/reports/trace/params"
import { getTraceDataset } from "./index"
import { poolRun, type Run } from "./common"

export const TRACE_ROW_LIMIT = 50_000

export function exportColumns(tab: TraceTab, header: "key" | "label"): ExportColumn[] {
  return TRACE_DATASETS[tab].columns.map((col) => ({
    key: col.key,
    label: header === "key" ? col.key : col.label,
    type: col.type === "number" ? "number" : "text",
    ...(col.type === "bool" ? { format: (v: unknown) => (v == null ? null : v ? "yes" : "no") } : {}),
  }))
}

/** Every row of one dataset, refused above the row limit rather than silently cut. */
export async function datasetRows(scope: UserScope, tab: TraceTab, q: TraceQuery, run: Run = poolRun) {
  const d = await getTraceDataset(scope, tab, { ...q, tab }, TRACE_ROW_LIMIT + 1, 0, run)
  if (d.total > TRACE_ROW_LIMIT) {
    throw new ApiError(413, "export_too_large",
      `${TRACE_DATASETS[tab].name}: ${d.total.toLocaleString()} rows match; the limit is ${TRACE_ROW_LIMIT.toLocaleString()}. Narrow the filters.`)
  }
  return d.rows
}

export const datasetCsv = async (scope: UserScope, tab: TraceTab, q: TraceQuery, run: Run = poolRun) =>
  buildCsv(exportColumns(tab, "key"), await datasetRows(scope, tab, q, run))

function readmeRows(q: TraceQuery, tabs: readonly TraceTab[], counts: Record<string, number>) {
  const rows: Record<string, unknown>[] = [
    { section: "Generated", item: formatDateTimeIST(new Date()), detail: `Contract ${TRACE_CONTRACT_VERSION}` },
    ...Object.entries(q.filters).filter(([, v]) => v).map(([k, v]) => ({ section: "Filter", item: k, detail: String(v) })),
    ...(q.status ? [{ section: "Filter", item: "status", detail: q.status }] : []),
    ...TRACE_CAVEATS.map((c, i) => ({ section: "Read first", item: String(i + 1), detail: c })),
  ]
  for (const t of tabs) {
    const ds = TRACE_DATASETS[t]
    rows.push({ section: ds.name, item: "grain", detail: `${ds.grain} · ${counts[t] ?? 0} rows` })
    for (const col of ds.columns) rows.push({ section: ds.name, item: col.label, detail: col.key })
  }
  return rows
}

/** All allowed datasets as one workbook, plus a Read-me sheet with filters, caveats and the column contract. */
export async function traceWorkbook(scope: UserScope, q: TraceQuery, tabs: readonly TraceTab[]): Promise<ArrayBuffer> {
  const sheets = await Promise.all(tabs.map(async (t) => ({
    name: TRACE_DATASETS[t].name.replace(/\s*↔\s*/g, " to ").replace(/[^\w -]/g, " ").slice(0, 31),
    columns: exportColumns(t, "label"),
    rows: await datasetRows(scope, t, q),
  })))
  const counts = Object.fromEntries(tabs.map((t, i) => [t, sheets[i].rows.length]))
  const readme = {
    name: "Read me",
    columns: [{ key: "section", label: "Section" }, { key: "item", label: "Item" }, { key: "detail", label: "Detail" }] as ExportColumn[],
    rows: readmeRows(q, tabs, counts),
  }
  return buildMultiSheetXlsx([readme, ...sheets])
}
