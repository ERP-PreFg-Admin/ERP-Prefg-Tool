import { createHash } from "node:crypto"
import type { ParsedInvoice } from "@/types/invoice"

// A Nanonets answer for one PDF, kept 24h so a re-parse of the same file is instant and unmetered.
export const PARSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type CachedParse = { at: string; parsed: ParsedInvoice }

export function parseCacheKey(pdf: Buffer): string {
  return `parse-cache/${createHash("sha256").update(pdf).digest("hex")}.json`
}

/** The cached parse if it is well-formed and younger than the TTL, else null. */
export function freshParse(entry: unknown, now: number): ParsedInvoice | null {
  const e = entry as Partial<CachedParse> | null
  if (!e || typeof e.at !== "string" || !Array.isArray(e.parsed?.line_items)) return null
  const age = now - Date.parse(e.at)
  return age >= 0 && age < PARSE_CACHE_TTL_MS ? e.parsed! : null
}
