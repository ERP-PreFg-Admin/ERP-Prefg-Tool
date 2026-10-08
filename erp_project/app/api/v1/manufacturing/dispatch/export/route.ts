// GET /api/v1/manufacturing/dispatch/export?format=&from=&to=&mfg=&q=&view=lines|mfg|sku
// Dispatch History in whichever view is on screen.

import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { assertInScope, getUserScope } from "@/lib/scope"
import { parseIso } from "@/lib/date"
import { buildExportFilename, exportResponse, type ExportColumn } from "@/lib/export"
import { getDispatchLines } from "@/lib/services/mfg-overview"
import { groupByMfg, groupBySku, parseView } from "@/app/po-tracking/mfg-overview/overview-model"

const COLUMNS: Record<"lines" | "mfg" | "sku", ExportColumn[]> = {
  lines: [
    { key: "mfg_code", label: "MFG Code" }, { key: "mfg_name", label: "MFG Name" },
    { key: "sku_code", label: "SKU Code" }, { key: "sku_name", label: "SKU Name" },
    { key: "invoices", label: "Invoices", type: "number" }, { key: "qty", label: "Qty Dispatched", type: "number" },
  ],
  mfg: [
    { key: "mfg_code", label: "MFG Code" }, { key: "mfg_name", label: "MFG Name" },
    { key: "skus", label: "SKUs", type: "number" }, { key: "qty", label: "Qty Dispatched", type: "number" },
  ],
  sku: [
    { key: "sku_code", label: "SKU Code" }, { key: "sku_name", label: "SKU Name" },
    { key: "mfgs", label: "Manufacturers", type: "number" }, { key: "qty", label: "Qty Dispatched", type: "number" },
  ],
}

export const GET = withGateway({
  access: { pageSlug: "/po-tracking/mfg-overview", level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
    const from = sp.get("from") ?? ""
    const to = sp.get("to") ?? ""
    if (!parseIso(from) || !parseIso(to)) throw new ApiError(400, "validation_error", "from and to must be YYYY-MM-DD")
    const mfgId = sp.get("mfg") ? Number(sp.get("mfg")) : null
    const view = parseView(sp.get("view"))

    const userId = Number(session.user.id)
    if (mfgId != null) assertInScope(await getUserScope(userId), "mfg", mfgId)
    const lines = await getDispatchLines(userId, { from, to, mfgId, search: sp.get("q") })
    const rows = view === "mfg" ? groupByMfg(lines) : view === "sku" ? groupBySku(lines) : lines

    return exportResponse(
      format, buildExportFilename("dispatch", format, { from, to, view }), "Dispatch",
      COLUMNS[view], rows as unknown as Record<string, unknown>[],
    )
  },
})
