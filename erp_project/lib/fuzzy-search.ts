/**
 * Server-side fuzzy ranking for master-page search boxes.
 *
 * Master list pages fetch the full set of rows matching all non-search
 * filters (status/type/zone/etc.) via each module's `*AllFiltered` query,
 * then rank them here against the free-text search term before slicing the
 * requested page. This replaces exact `LIKE '%term%'` matching with typo
 * tolerance while keeping the DB-level LIMIT/OFFSET path untouched when no
 * search term is present.
 */

import Fuse from "fuse.js"

export function fuzzyRank<T>(rows: T[], term: string, keys: string[]): T[] {
  if (!term.trim()) return rows
  const fuse = new Fuse(rows, { keys, threshold: 0.25, ignoreLocation: true })
  return fuse.search(term).map((r) => r.item)
}
