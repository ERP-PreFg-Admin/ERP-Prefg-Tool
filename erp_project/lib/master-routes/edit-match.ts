// Shared "is this CSV row an edit of an existing record?" scorer, used by the
// manufacturer + vendor bulk CSV importers (preview `check_duplicates`, the
// staging-count loops in bulk/bulk_from_s3, and the *_BULK approval handlers'
// applyAndArchive). A row used to match only on an exact `name` hit, which
// broke the moment a user intentionally renamed a record — the row would
// look like a brand-new insert and its reused GST/registered_name would get
// flagged as a duplicate instead of applied as an edit.
//
// Instead, a row is matched to whichever existing record it agrees with on
// at least EDIT_MATCH_THRESHOLD of {name, registered_name, gst_number} —
// letting any one of the three change without losing the match.
import type { PoolConnection } from "mysql2/promise"
import { query } from "@/lib/db"

export type EditCandidate = {
  id: number
  code: string
  name: string
  registered_name: string | null
  gst_number: string | null
  [key: string]: unknown
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase()

export const EDIT_MATCH_THRESHOLD = 2

function scoreEditMatch(row: Record<string, unknown>, candidate: EditCandidate): number {
  const rowName = norm(row.name)
  const rowRegisteredName = norm(row.registered_name)
  const rowGst = norm(row.gst_number)
  let score = 0
  if (rowName && rowName === norm(candidate.name)) score++
  if (rowRegisteredName && rowRegisteredName === norm(candidate.registered_name)) score++
  if (rowGst && rowGst === norm(candidate.gst_number)) score++
  return score
}

/** Picks the highest-scoring candidate at or above EDIT_MATCH_THRESHOLD, or null. */
export function findBestEditMatch<T extends EditCandidate>(
  row: Record<string, unknown>,
  candidates: T[]
): T | null {
  let best: T | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = scoreEditMatch(row, candidate)
    if (score >= EDIT_MATCH_THRESHOLD && score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

export type SingleRowCandidateSql = {
  selectByName: string
  selectByRegisteredName: string
  selectByGstNumber: string
}

/**
 * Resolves the best existing-record match for ONE CSV row inside an open
 * transaction — used by the staging-count loops (route.ts "bulk" /
 * "bulk_from_s3") and the *_BULK approval handlers' applyAndArchive, all of
 * which use `conn.execute` (prepared statements) and so can't lean on
 * `query()`'s `IN (?)` array batching.
 */
export async function findEditMatchForRow<T extends EditCandidate>(
  conn: PoolConnection,
  sql: SingleRowCandidateSql,
  row: Record<string, unknown>
): Promise<T | null> {
  const name = String(row.name ?? "").trim()
  const registeredName = String(row.registered_name ?? "").trim()
  const gstNumber = String(row.gst_number ?? "").trim()

  const candidates = new Map<number, T>()
  const collect = async (sqlStr: string, val: string) => {
    if (!val) return
    const [rows] = await conn.execute(sqlStr, [val])
    for (const r of rows as T[]) candidates.set(r.id, r)
  }
  await collect(sql.selectByName, name)
  await collect(sql.selectByRegisteredName, registeredName)
  await collect(sql.selectByGstNumber, gstNumber)

  return findBestEditMatch(row, [...candidates.values()])
}

export type BatchCandidateSql = {
  selectCandidatesByNames: string
  selectCandidatesByRegisteredNames: string
  selectCandidatesByGstNumbers: string
}

/**
 * Batched counterpart for the CSV-preview `check_duplicates` action: fetches
 * one shared candidate pool for the WHOLE uploaded file via `query()`'s
 * `IN (?)` array support, instead of one round-trip per row.
 */
export async function fetchEditMatchCandidates<T extends EditCandidate>(
  sql: BatchCandidateSql,
  rows: Record<string, unknown>[]
): Promise<T[]> {
  const names = [...new Set(rows.map((r) => String(r.name ?? "").trim()).filter(Boolean))]
  const registeredNames = [...new Set(rows.map((r) => String(r.registered_name ?? "").trim()).filter(Boolean))]
  const gstNumbers = [...new Set(rows.map((r) => String(r.gst_number ?? "").trim()).filter(Boolean))]

  const candidates = new Map<number, T>()
  const collect = async (sqlStr: string, values: string[]) => {
    if (values.length === 0) return
    const found = await query<T>(sqlStr, [values])
    for (const c of found) candidates.set(c.id, c)
  }
  await Promise.all([
    collect(sql.selectCandidatesByNames, names),
    collect(sql.selectCandidatesByRegisteredNames, registeredNames),
    collect(sql.selectCandidatesByGstNumbers, gstNumbers),
  ])
  return [...candidates.values()]
}
