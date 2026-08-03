/**
 * BOM code versioning — `<sku_code>RM<rm_version>PM<pm_version>` encodes RM
 * and PM version numbers that bump INDEPENDENTLY: creating a new BOM version
 * only increments the side (RM lines or PM lines) that actually changed vs.
 * the SKU's immediately-prior BOM. Applies to new (non-backfilled), non-bulk
 * BOMs only — see app/api/masters/bom-master/route.ts's "new-version" path.
 */

export type DiffableLine = { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number | string; uom?: string | null }

function lineKey(l: DiffableLine): string {
  return `${l.mtrl_type}:${l.mtrl_id}:${String(l.amount)}:${l.uom ?? ""}`
}

/** Compares the RM-line set and PM-line set independently — any addition, removal, or amount/uom change on a side marks that side changed. */
export function diffBomLines(
  oldLines: DiffableLine[],
  newLines: DiffableLine[]
): { rmChanged: boolean; pmChanged: boolean } {
  const oldRm = new Set(oldLines.filter((l) => l.mtrl_type === "rm").map(lineKey))
  const newRm = new Set(newLines.filter((l) => l.mtrl_type === "rm").map(lineKey))
  const oldPm = new Set(oldLines.filter((l) => l.mtrl_type === "pm").map(lineKey))
  const newPm = new Set(newLines.filter((l) => l.mtrl_type === "pm").map(lineKey))

  const setsDiffer = (a: Set<string>, b: Set<string>) =>
    a.size !== b.size || [...a].some((k) => !b.has(k))

  return {
    rmChanged: setsDiffer(oldRm, newRm),
    pmChanged: setsDiffer(oldPm, newPm),
  }
}
