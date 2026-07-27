/**
 * Query timing utility for performance auditing.
 *
 * Wraps query() calls to measure and log execution time.
 * Use `timedQuery()` instead of `query()` to get automatic timing.
 *
 * Output goes to console:
 *   [QUERY] getItems (2.34ms) — approval_items SELECT
 *   [QUERY] listPending (8.12ms) — approvals JOIN users
 *   [SLOW QUERY] selectPaginated (145.67ms) ⚠️ — master_skus with search
 */

import { query as dbQuery } from "@/lib/db"

export interface TimingOptions {
  label?: string       // Custom label for readability (defaults to sanitized SQL)
  warnThreshold?: number // ms threshold to mark as slow (default: 50ms)
  queryFn?: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> // defaults to lib/db.ts's query() — pass queryDwh from lib/db-sku.ts to time the SKU data warehouse pool instead
}

export async function timedQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  options: TimingOptions = {}
): Promise<T[]> {
  const { label, warnThreshold = 50, queryFn = dbQuery } = options

  // Generate a descriptive label from SQL if not provided
  const description = label || extractQueryLabel(sql)

  const start = performance.now()
  const result = await queryFn<T>(sql, params)
  const duration = performance.now() - start

  const durationStr = duration.toFixed(2)
  const isSlow = duration > warnThreshold
  const prefix = isSlow ? "🐢 [SLOW]" : "[QUERY]"

  console.log(`${prefix} ${description} (${durationStr}ms)`)

  return result
}

/**
 * Batch parallel queries with timing.
 * Usage:
 *   const [vendors, mfgs, rms] = await timedParallel([
 *     [sql1, params1, "Load vendors"],
 *     [sql2, params2, "Load manufacturers"],
 *     [sql3, params3, "Load raw materials"]
 *   ])
 */
export async function timedParallel<T extends unknown[]>(
  queries: Array<[sql: string, params?: unknown[], label?: string]>
): Promise<T[]> {
  const start = performance.now()

  const results = await Promise.all(
    queries.map(([sql, params, label]) =>
      timedQuery(sql, params, { label })
    )
  )

  const duration = performance.now() - start
  console.log(`[PARALLEL] ${queries.length} queries completed in ${duration.toFixed(2)}ms`)

  return results as T[]
}

/**
 * Extract a short label from SQL for logging.
 * Examples:
 *   "SELECT * FROM master_skus WHERE..." → "master_skus SELECT"
 *   "INSERT INTO approvals..." → "approvals INSERT"
 *   "UPDATE master_vendors..." → "master_vendors UPDATE"
 */
function extractQueryLabel(sql: string): string {
  const normalized = sql.trim().toUpperCase()

  // INSERT
  const insertMatch = normalized.match(/INSERT INTO\s+(\w+)/)
  if (insertMatch) return `${insertMatch[1]} INSERT`

  // UPDATE
  const updateMatch = normalized.match(/UPDATE\s+(\w+)/)
  if (updateMatch) return `${updateMatch[1]} UPDATE`

  // DELETE
  const deleteMatch = normalized.match(/DELETE FROM\s+(\w+)/)
  if (deleteMatch) return `${deleteMatch[1]} DELETE`

  // SELECT — extract main table
  const selectMatch = normalized.match(/FROM\s+(\w+)/)
  if (selectMatch) return `${selectMatch[1]} SELECT`

  // Fallback
  return "query"
}
