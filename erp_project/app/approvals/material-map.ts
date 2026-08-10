import type { MaterialMap } from "./ApprovalCard"

/** Build the RM/PM id → {code, name} lookup consumed by ApprovalCard's Recipe
 *  line diff table. `rmRows`/`pmRows` come from the cached active-material
 *  reference lists (see lib/cached-reference-data.ts). */
export function buildMaterialMap(
  rmRows: Array<{ id: number; rm_code: string | null; name: string }>,
  pmRows: Array<{ id: number; pm_code: string | null; name: string }>
): MaterialMap {
  return {
    rm: Object.fromEntries(rmRows.map((r) => [r.id, { code: r.rm_code, name: r.name }])),
    pm: Object.fromEntries(pmRows.map((r) => [r.id, { code: r.pm_code, name: r.name }])),
  }
}
