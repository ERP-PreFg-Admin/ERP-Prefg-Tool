import { brandKey } from "../constants"

export type BrandRow = { id: number; brand_key: string; name: string }

export type BrandMatch =
  | { ok: true; brandId: number; name: string }
  | { ok: false; code: "brand_required" | "unknown_brand"; message: string }

/** Which master_brand row a SKU's brand text names. Blank or unknown is refused, never stored as NULL. */
export function matchSkuBrand(brands: BrandRow[], text: string | null | undefined): BrandMatch {
  const raw = (text ?? "").trim()
  if (!raw) return { ok: false, code: "brand_required", message: "Brand is required." }
  const hit = brands.find((b) => b.brand_key === brandKey(raw))
  if (hit) return { ok: true, brandId: hit.id, name: hit.name }
  const known = brands.map((b) => b.name).join(", ")
  return { ok: false, code: "unknown_brand", message: `Brand "${raw}" is not a known brand (${known}).` }
}
