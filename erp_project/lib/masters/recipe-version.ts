/**
 * Recipe code versioning — `<sku_code>-RM<rm_version>-PM<pm_version>` encodes RM
 * and PM version numbers that bump INDEPENDENTLY: creating a new Recipe version
 * only increments the side (RM lines or PM lines) that actually changed vs.
 * the SKU's immediately-prior Recipe. Applies uniformly to every new (non-
 * backfilled) Recipe regardless of upload path — see the "new-version" branch
 * of app/api/v1/masters/recipe-master/route.ts (single-Recipe wizard/edit) and
 * bomBulkHandler.applyAndArchive in lib/approvals/handlers/bom.ts (CSV bulk).
 */

export type DiffableLine = { mtrl_type: "rm" | "pm"; mtrl_id: number; amount: number | string; uom?: string | null }

function lineKey(l: DiffableLine): string {
  // Normalize amount to a number before stringifying — the DB returns
  // DECIMAL(12,4) columns as fixed-precision strings (e.g. "40.0000"), while
  // client-submitted amounts are plain numbers (e.g. 40). Comparing the raw
  // strings would flag every line as "changed" even when the value is
  // identical, which defeats the whole point of diffing RM/PM independently.
  const amount = Number(l.amount)
  const normalizedAmount = Number.isFinite(amount) ? amount : l.amount
  return `${l.mtrl_type}:${l.mtrl_id}:${normalizedAmount}:${(l.uom ?? "").trim().toLowerCase()}`
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
