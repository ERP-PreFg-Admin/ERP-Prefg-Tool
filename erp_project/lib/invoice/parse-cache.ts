import { createHash } from "node:crypto"
import { monthIST } from "@/lib/date"
import type { ParsedInvoice } from "@/types/invoice"

// A Nanonets answer for one PDF, kept 24h so a re-parse of the same file is instant and unmetered.
export const PARSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type CachedParse = { at: string; parsed: ParsedInvoice }

/** Nanonets' reply exactly as it arrived, next to the cache entry. Kept as the record, never read back. */
export type RawParse = {
  at: string
  filename: string
  mfg: string | null
  strategy: string
  hash: string
  sent_config: unknown
  response: unknown
}

export type ParseCacheKeyInput = { filename: string; mfgCode?: string | null; at?: Date }

const safe = (s: string) => s.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "invoice"

/** `parse-cache/<YYYY-MM IST>/<mfg code>/<file name>__<sha256 first 12>.json` — readable, still rebuilt on a retry. */
export function parseCacheKey(pdf: Buffer, { filename, mfgCode, at = new Date() }: ParseCacheKeyInput): string {
  const hash = createHash("sha256").update(pdf).digest("hex").slice(0, 12)
  return `parse-cache/${monthIST(at)}/${safe(mfgCode?.trim() || "unknown")}/${safe(filename)}__${hash}.json`
}

export const rawParseKey = (cacheKey: string) => cacheKey.replace(/\.json$/, ".raw.json")

/** The cached parse if it is well-formed and younger than the TTL, else null. */
export function freshParse(entry: unknown, now: number): ParsedInvoice | null {
  const e = entry as Partial<CachedParse> | null
  if (!e || typeof e.at !== "string" || !Array.isArray(e.parsed?.line_items)) return null
  const age = now - Date.parse(e.at)
  return age >= 0 && age < PARSE_CACHE_TTL_MS ? e.parsed! : null
}
