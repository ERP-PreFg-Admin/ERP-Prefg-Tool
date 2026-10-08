// GET /api/v1/manufacturing/open-pos/export?format=csv|xlsx&q=
// The Open POs matrix as on screen: one row per SKU, one open-qty column per manufacturer.

import { withGateway } from "@/lib/gateway/with-gateway"
import { buildExportFilename, exportResponse, type ExportColumn } from "@/lib/export"
import { getOpenPoCells } from "@/lib/services/mfg-overview"
import { buildOpenPoMatrix, matchesSku } from "@/app/po-tracking/mfg-overview/overview-model"

export const GET = withGateway({
  access: { pageSlug: "/po-tracking/mfg-overview", level: "viewer" },
  handler: async ({ req, session }) => {
    const sp = req.nextUrl.searchParams
    const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
    const q = sp.get("q") ?? ""

    const { mfgs, skus } = buildOpenPoMatrix(await getOpenPoCells(Number(session.user.id)))
    const columns: ExportColumn[] = [
      { key: "rank", label: "#", type: "number" },
      { key: "sku_code", label: "SKU Code" },
      { key: "sku_name", label: "SKU Name" },
      { key: "total", label: "Total Open Qty", type: "number" },
      ...mfgs.map((m) => ({ key: `m${m.id}`, label: `${m.name} (${m.code})`, type: "number" as const })),
    ]
    const rows = skus.filter((s) => matchesSku(s, q)).map((s, i) => ({
      rank: i + 1,
      sku_code: s.sku_code,
      sku_name: s.sku_name,
      total: s.total,
      ...Object.fromEntries(mfgs.map((m) => [`m${m.id}`, s.cells[m.id]?.open_qty ?? null])),
    }))

    return exportResponse(format, buildExportFilename("open_pos", format, { q: q || null }), "Open POs", columns, rows)
  },
})
