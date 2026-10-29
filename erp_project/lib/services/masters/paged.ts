// The masters list read: a search ranks every filtered row in memory, otherwise the DB pages.
import { fuzzyRank } from "@/lib/fuzzy-search"

export async function pagedOrRanked<T>(o: {
  search: string
  offset: number
  size: number
  fuzzyKeys: string[]
  all: () => Promise<T[]>
  page: () => Promise<T[]>
  count: () => Promise<{ total: number }[]>
}): Promise<{ rows: T[]; total: number }> {
  if (o.search) {
    const ranked = fuzzyRank(await o.all(), o.search, o.fuzzyKeys)
    return { rows: ranked.slice(o.offset, o.offset + o.size), total: ranked.length }
  }
  const [rows, countRows] = await Promise.all([o.page(), o.count()])
  return { rows, total: Number(countRows[0]?.total ?? 0) }
}

/** Elapsed ms since the call, for the [AUDIT] load lines. */
export function stopwatch(): () => string {
  const start = performance.now()
  return () => (performance.now() - start).toFixed(2)
}
