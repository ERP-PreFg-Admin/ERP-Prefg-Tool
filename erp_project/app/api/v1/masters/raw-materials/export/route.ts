/**
 * GET /api/v1/masters/raw-materials/export
 *
 * Exports raw material records for either the vendor or manufacturer rate view.
 * The `view` param mirrors the toggle on the /masters/raw-materials page so the
 * downloaded file always matches what the user is looking at.
 *
 * Query params (all optional):
 *   format — "csv" (default) | "xlsx"
 *   view   — "manufacturer" | anything else → vendor view (default)
 *   search — searches rm_code and name
 *   status — "active" | "discontinued"
 *
 * Responses:
 *   200  — file attachment
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT
 *   500  — server error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { rawMaterials as rmSql } from "@/lib/queries/raw-materials"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { RM_VENDOR_EXPORT_COLUMNS, RM_MFG_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import { getUserScope } from "@/lib/scope"
import logger from "@/lib/logger"

const ROW_LIMIT = 50_000

export const GET = withGateway({
  access: { pageSlug: "/masters/raw-materials", level: "viewer" },
  handler: async ({ req, session }) => {
  const sp      = req.nextUrl.searchParams
  const format  = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const isMfg   = sp.get("view") === "manufacturer"
  const search  = sp.get("search") ?? ""
  const status  = sp.get("status") ?? ""

  const columns   = isMfg ? RM_MFG_EXPORT_COLUMNS      : RM_VENDOR_EXPORT_COLUMNS
  const countSql  = isMfg ? rmSql.countMfg              : rmSql.countVendor
  const dataSql   = isMfg ? rmSql.selectMfgAllFiltered  : rmSql.selectVendorAllFiltered
  const viewLabel = isMfg ? "MRM"  : "VRM"
  const sheetName = isMfg ? "RM_MRM"   : "RM_VRM"

  const scope = await getUserScope(Number(session.user.id))
  let filterParams: unknown[]
  let filename: string
  if (isMfg) {
    const mfgCode    = sp.get("mfg_code")           ?? ""
    const mfgRateMin = sp.get("mfg_rate_min")        ?? ""
    const mfgRateMax = sp.get("mfg_rate_max")        ?? ""
    const mfgEffFrom = sp.get("mfg_effective_from")  ?? ""
    const typeFilter = sp.get("type") ?? ""
    filterParams = rmSql.mfgFilterParams(
      search || null, status || null, typeFilter || null, mfgCode || null,
      mfgRateMin || null, mfgRateMax || null, mfgEffFrom || null, scope
    )
    filename = buildExportFilename(`RM_${viewLabel}`, format, {
      search:             search      || null,
      status:             status      || null,
      mfg_code:           mfgCode     || null,
      mfg_rate_min:       mfgRateMin  || null,
      mfg_rate_max:       mfgRateMax  || null,
      mfg_effective_from: mfgEffFrom  || null,
    })
  } else {
    const make           = sp.get("make")           ?? ""
    const vendorCode     = sp.get("vendor_code")    ?? ""
    const rateMin        = sp.get("rate_min")        ?? ""
    const rateMax        = sp.get("rate_max")        ?? ""
    const effectiveFrom  = sp.get("effective_from") ?? ""
    const typeFilter2 = sp.get("type") ?? ""
    filterParams = rmSql.vendorFilterParams(
      search || null, status || null, make || null, typeFilter2 || null,
      vendorCode || null, rateMin || null, rateMax || null, effectiveFrom || null, scope
    )
    filename = buildExportFilename(`raw_materials_${viewLabel}`, format, {
      search:         search         || null,
      status:         status         || null,
      make:           make           || null,
      vendor_code:    vendorCode     || null,
      rate_min:       rateMin        || null,
      rate_max:       rateMax        || null,
      effective_from: effectiveFrom  || null,
    })
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
    console.log(`[/api/v1/masters/raw-materials/export] served ${rows.length} rows as ${format} (view=${viewLabel})`)
    logger.info({ message: "Raw materials export", userId: session.user.id, format, view: viewLabel, rowCount: rows.length }) 
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
    logger.error({ message: "Raw materials export failed", userId: session.user.id, format, view: viewLabel, err })
    console.error("[/api/v1/masters/raw-materials/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
