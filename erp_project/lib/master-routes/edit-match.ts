// Shared "is this CSV row an edit of an existing record?" resolver, used by
// the manufacturer + vendor bulk CSV importers (preview `check_duplicates`,
// the staging step in "bulk"/"bulk_from_s3", and the *_BULK approval
// handlers' applyAndArchive). A row is an edit of the record whose `code`
// (the record's own business code, e.g. MFG-001-REV) matches the row's
// `code` cell exactly. No code — the row is always a new record; we don't
// guess based on name/gst/registered_name, since a rename or a legitimately
// reused GST is completely valid on a genuinely new record too.
import type { PoolConnection } from "mysql2/promise"
import { query } from "@/lib/db"

export type EditCandidate = {
  id: number
  code: string
  [key: string]: unknown
}

/** Resolves the existing record ONE CSV row edits, by exact `code` match —
 *  used inside an open transaction (`conn.execute`), e.g. the staging step
 *  and the *_BULK handlers' applyAndArchive. */
export async function findEditMatchForRow<T extends EditCandidate>(
  conn: PoolConnection,
  selectByCodeSql: string,
  row: Record<string, unknown>
): Promise<T | null> {
  const code = String(row.code ?? "").trim()
  if (!code) return null
  const [rows] = await conn.execute(selectByCodeSql, [code])
  return (rows as T[])[0] ?? null
}

/**
 * Batched counterpart for the CSV-preview `check_duplicates` action: fetches
 * every candidate the WHOLE uploaded file could reference via `query()`'s
 * `IN (?)` array support, instead of one round-trip per row.
 */
export async function fetchEditMatchCandidates<T extends EditCandidate>(
  selectCandidatesByCodesSql: string,
  rows: Record<string, unknown>[]
): Promise<T[]> {
  const codes = [...new Set(rows.map((r) => String(r.code ?? "").trim()).filter(Boolean))]
  if (codes.length === 0) return []
  return query<T>(selectCandidatesByCodesSql, [codes])
}

/** A row matches whichever candidate shares its exact `code`, or null if the
 *  row has no code (always a new record) or the code matches nothing. */
export function findBestEditMatch<T extends EditCandidate>(
  row: Record<string, unknown>,
  candidates: T[]
): T | null {
  const code = String(row.code ?? "").trim()
  if (!code) return null
  return candidates.find((c) => c.code === code) ?? null
}
