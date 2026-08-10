/**
 * GET /api/v1/masters/packing-materials/export
 *
 * Exports packing material records for either the vendor or manufacturer rate
 * view. The `view` param mirrors the toggle on /masters/packing-materials so
 * the downloaded file always matches what the user is looking at.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   view   — "manufacturer" | anything else → vendor view (default)
 *   search — searches pm_code and name
 *   status — "active" | "discontinued | "inactive"
 *
 * Responses:
 *   200  — file attachment
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT
 *   500  — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { packingMaterials as pmSql } from "@/lib/queries/packing-materials"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { PM_VENDOR_EXPORT_COLUMNS, PM_MFG_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope } from "@/lib/scope"
import logger from "@/lib/logger"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/packing-materials", level: "viewer" },
  handler: async ({ req, session }) => {
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const isMfg  = sp.get("view") === "manufacturer"
  const search = sp.get("search") ?? ""
  const status = sp.get("status") ?? ""

  const columns   = isMfg ? PM_MFG_EXPORT_COLUMNS : PM_VENDOR_EXPORT_COLUMNS
  const countSql  = isMfg ? pmSql.countMfg         : pmSql.countVendor
  const dataSql   = isMfg ? pmSql.selectMfgAllFiltered : pmSql.selectVendorAllFiltered
  const viewLabel = isMfg ? "MFG" : "VEN"
  const sheetName = isMfg ? "PM_MRM" : "PM_VRM"

  const scope = await getUserScope(Number(session.user.id))
  let filterParams: unknown[]
  if (isMfg) {
    const mfgCode     = sp.get("mfg_code")           ?? ""
    const mfgRateMin  = sp.get("mfg_rate_min")        ?? ""
    const mfgRateMax  = sp.get("mfg_rate_max")        ?? ""
    const mfgEffFrom  = sp.get("mfg_effective_from")  ?? ""
    const makeFilter = sp.get("make") ?? ""
    filterParams = pmSql.mfgFilterParams(
      search || null, status || null, makeFilter || null, mfgCode || null,
      mfgRateMin || null, mfgRateMax || null, mfgEffFrom || null, scope
    )
  } else {
    const make        = sp.get("make")          ?? ""
    const vendorCode  = sp.get("vendor_code")   ?? ""
    const rateMin     = sp.get("rate_min")       ?? ""
    const rateMax     = sp.get("rate_max")       ?? ""
    const effectiveFrom = sp.get("effective_from") ?? ""
    filterParams = pmSql.vendorFilterParams(
      search || null, status || null, make || null,
      vendorCode || null, rateMin || null, rateMax || null, effectiveFrom || null, scope
    )
  }

  try {
    const [{ total }] = await query<{ total: number }>(countSql, filterParams)
    if (total > ROW_LIMIT) {
      return NextResponse.json(
        { error: `Export limited to ${ROW_LIMIT.toLocaleString()} rows. Query returned ${total.toLocaleString()}. Apply filters to narrow the result.` },
        { status: 413 }
      )
    }

    const rows = await query<Record<string, unknown>>(dataSql, filterParams)

    const filename = isMfg
      ? buildExportFilename(`packing_materials_${viewLabel}`, format, {
          search:             search                             || null,
          status:             status                             || null,
          mfg_code:           sp.get("mfg_code")                || null,
          mfg_rate_min:       sp.get("mfg_rate_min")            || null,
          mfg_rate_max:       sp.get("mfg_rate_max")            || null,
          mfg_effective_from: sp.get("mfg_effective_from")      || null,
        })
      : buildExportFilename(`packing_materials_${viewLabel}`, format, {
          search:         search                              || null,
          status:         status                              || null,
          make:           sp.get("make")                     || null,
          vendor_code:    sp.get("vendor_code")              || null,
          rate_min:       sp.get("rate_min")                 || null,
          rate_max:       sp.get("rate_max")                 || null,
          effective_from: sp.get("effective_from")           || null,
        })

    logger.info({message:"Packing materials export served." , userId: session.user.id , format, view: viewLabel, rowCount: rows.length})
    console.log(`[/api/v1/masters/packing-materials/export] served ${rows.length} rows as ${format} (view=${viewLabel})`)

    if (format === "xlsx") {
      const buffer = await buildXlsx(sheetName, columns, rows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(columns, rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    logger.error({message:"Packing material export failed", userId: session.user.id , format, view:viewLabel , error:err})
    console.error("[/api/v1/masters/packing-materials/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
