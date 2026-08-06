/**
 * GET /api/masters/skus/export
 *
 * Streams a CSV or Excel file containing all SKU records that match the
 * current active filters. Pagination is intentionally bypassed — the full
 * filtered result set is exported in one shot.
 *
 * Reads `master_skus` through lib/queries/skus.ts — the SAME source, filters
 * and fuzzy-search path as app/masters/skus/page.tsx — so the file always
 * matches what the user sees on screen. (It previously read the DWH table via
 * lib/queries/sku-details.ts, which has a narrower/differently-named column
 * set; that is why sku_type / filling / gst / bom came out blank or missing.)
 *
 * Query params (all optional):
 *   format      — "csv" (default) | "xlsx"
 *   search      — fuzzy match over sku_code, name, brand
 *   status      — "active" | "inactive" | "discontinued"
 *   brand       — exact Brand match (e.g. "HYPHEN")
 *   sku_type    — exact sku_type match
 *   category    — exact category match
 *   subcategory — exact subcategory match
 *   bom         — "missing" to restrict to SKUs with no active BOM
 *
 * Responses:
 *   200  — file attachment (CSV or XLSX)
 *   401  — unauthenticated
 *   413  — result set exceeds ROW_LIMIT; apply filters to narrow it down
 *   500  — database or serialization error
 */

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { skus as skuSql } from "@/lib/queries/skus"
import { bom as bomSql } from "@/lib/queries/bom"
import { fuzzyRank } from "@/lib/fuzzy-search"
import { buildCsv, buildXlsx, buildExportFilename } from "@/lib/export"
import { SKU_EXPORT_COLUMNS } from "@/lib/export-configs"
import { withGateway } from "@/lib/gateway/with-gateway"
import type { Sku } from "@/types/masters"

/** Hard cap on exported rows to prevent out-of-memory on large tables. */
const ROW_LIMIT = 50_000

const tooManyRows = (total: number) =>
  NextResponse.json(
    {
      error: `Export is limited to ${ROW_LIMIT.toLocaleString()} rows. Your query returned ${total.toLocaleString()} records. Apply filters (status or search) to narrow the result.`,
    },
    { status: 413 }
  )

export const GET = withGateway({
  access: { pageSlug: "/masters/skus", level: "viewer" },
  handler: async ({ req }) => {
  // ── Parse params ──────────────────────────────────────────────────────────
  const sp     = req.nextUrl.searchParams
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv"
  const search = sp.get("search") ?? ""

  const status      = sp.get("status") || null
  const brand       = sp.get("brand") || null
  const skuType     = sp.get("sku_type") || null
  const category    = sp.get("category") || null
  const subcategory = sp.get("subcategory") || null
  // Any non-null value activates the "AND active_bom_id IS NULL" branch — the
  // value itself is never compared, so 1 is just a truthy placeholder.
  const missingBom  = sp.get("bom") === "missing" ? 1 : null

  /**
   * Param order matches selectPaginated / selectAllFiltered / countAll:
   * [like×4, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom].
   * `like` is passed as null on the search path — free text is applied by
   * fuzzyRank afterwards, exactly as the page does.
   */
  const filterParams = (like: string | null) => [
    like, like, like, like,
    status, status,
    brand, brand,
    skuType, skuType,
    category, category,
    subcategory, subcategory,
    missingBom,
  ]

  try {
    let rows: Sku[]

    if (search) {
      // Fuzzy path: fetch everything matching the non-search filters, then rank.
      // The cap is checked against the ranked set, since fuzzy narrowing happens
      // in memory and can bring an over-limit result set under the cap.
      const allMatching = await query<Sku>(skuSql.selectAllFiltered, filterParams(null))
      rows = fuzzyRank(allMatching, search, ["sku_code", "name", "brand"])
      if (rows.length > ROW_LIMIT) return tooManyRows(rows.length)
    } else {
      // ── Row cap check before pulling the full set ──────────────────────────
      const [{ total }] = await query<{ total: number }>(skuSql.countAll, filterParams(null))
      if (total > ROW_LIMIT) return tooManyRows(total)

      rows = await query<Sku>(skuSql.selectAllFiltered, filterParams(null))
    }

    // ── Resolve active_bom_id -> bom_code (mirrors page.tsx) ──────────────────
    const bomIds = [...new Set(rows.map((r) => r.active_bom_id).filter((id): id is number => id != null))]
    if (bomIds.length > 0) {
      const bomRows = await query<{ id: number; bom_code: string }>(bomSql.selectBomCodesByIds, [bomIds])
      const bomCodeById = new Map(bomRows.map((b) => [b.id, b.bom_code]))
      rows = rows.map((r) => ({
        ...r,
        bom_code: r.active_bom_id != null ? bomCodeById.get(r.active_bom_id) ?? null : null,
      }))
    }

    // ── Build and return file ─────────────────────────────────────────────────
    const filename = buildExportFilename("skus", format, {
      search:      search || null,
      status,
      brand,
      sku_type:    skuType,
      category,
      subcategory,
      bom:         missingBom ? "missing-bom" : null,
    })

    const exportRows = rows as unknown as Record<string, unknown>[]

    console.log(`[/api/masters/skus/export] served ${rows.length} rows as ${format}`)

    if (format === "xlsx") {
      const buffer = await buildXlsx("SKUs", SKU_EXPORT_COLUMNS, exportRows)
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildCsv(SKU_EXPORT_COLUMNS, exportRows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    console.error("[/api/masters/skus/export]", err)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
  },
})
