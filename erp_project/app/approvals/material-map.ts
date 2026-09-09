import type { MaterialMap } from "./approval-card/types"

/** Build the RM/PM/SKU id → {code, name} lookup consumed by ApprovalCard's Recipe
 *  line diff table. `rmRows`/`pmRows` come from the cached active-material
 *  reference lists (see lib/cached-reference-data.ts).
 *
 *  `skuRows` resolves a gift kit's contents lines (mtrl_type='sku'). Without it the
 *  approval card labels each component `#42` — a bare auto-increment id — which for
 *  a kit is the entire recipe an approver is being asked to approve. */
export function buildMaterialMap(
  rmRows: Array<{ id: number; rm_code: string | null; name: string }>,
  pmRows: Array<{ id: number; pm_code: string | null; name: string }>,
  skuRows: Array<{ id: number; sku_code: string | null; name: string }> = []
): MaterialMap {
  return {
    rm: Object.fromEntries(rmRows.map((r) => [r.id, { code: r.rm_code, name: r.name }])),
    pm: Object.fromEntries(pmRows.map((r) => [r.id, { code: r.pm_code, name: r.name }])),
    sku: Object.fromEntries(skuRows.map((r) => [r.id, { code: r.sku_code, name: r.name }])),
  }
}
