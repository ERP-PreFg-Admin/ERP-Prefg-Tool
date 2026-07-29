/**
 * Pagination utilities shared by all master page server components.
 *
 * Two exports:
 *   parsePaginationParams — safely reads ?page / ?size from URL searchParams
 *   paginate<T>           — runs the data query + COUNT query in parallel and
 *                           returns a typed PageResult
 *
 * SQL contract expected by `paginate`:
 *   - dataQuery  must accept LIMIT and OFFSET as its last two prepared params
 *   - countQuery must accept the same WHERE params as dataQuery minus LIMIT/OFFSET
 *     and must return a single row shaped { total: number }
 */

import { query } from "@/lib/db"

// ─── Types ───────────────────────────────────────────────────────────────────

export type PaginationParams = {
  page:   number  // 1-based current page
  size:   number  // rows per page (clamped to 5–100)
  offset: number  // SQL OFFSET = (page - 1) * size
}

export type PageResult<T> = {
  rows:     T[]     // the fetched slice for this page
  total:    number  // total matching rows across all pages
  page:     number  // current page number
  pageSize: number  // rows per page used for this query
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse ?page and ?size from Next.js searchParams.
 *
 * Clamps: page ≥ 1, size in [5, 100].
 * Falls back gracefully for missing or non-numeric values.
 */
export function parsePaginationParams(
  sp: Record<string, string | string[] | undefined>,
  defaults = { page: 1, size: 20 }
): PaginationParams {
  const page = Math.max(
    1,
    parseInt(String(sp.page ?? defaults.page), 10) || 1
  )
  const size = Math.min(
    100,
    Math.max(5, parseInt(String(sp.size ?? defaults.size), 10) || 20)
  )
  return { page, size, offset: (page - 1) * size }
}

/**
 * Run a data query and a COUNT query in parallel and return a PageResult.
 *
 * Running both concurrently cuts round-trip latency roughly in half compared
 * to sequential execution, since COUNT(*) with indexed WHERE is cheap.
 */
export async function paginate<T>(
  dataQuery:   string,
  dataParams:  unknown[],
  countQuery:  string,
  countParams: unknown[],
  page:        number,
  size:        number
): Promise<PageResult<T>> {
  const [rows, countRows] = await Promise.all([
    query<T>(dataQuery, dataParams),
    query<{ total: number }>(countQuery, countParams),
  ])

  return {
    rows,
    // The COUNT result comes back as a string from mysql2 — Number() normalises it.
    total:    Number(countRows[0]?.total ?? 0),
    page,
    pageSize: size,
  }
}
