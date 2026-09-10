/**
 * Recipe code versioning — `<sku_code>-RM<rm_version>-PM<pm_version>` encodes RM
 * and PM version numbers that bump INDEPENDENTLY: a new Recipe version only
 * increments the side (RM lines or PM lines) that actually changed.
 *
 * The two sides count on DIFFERENT lineages, which is the thing to hold onto:
 * PM against the SKU's own immediately-prior Recipe, RM against the SKU's
 * VARIANT FAMILY (see resolveRecipeVersions below and
 * lib/masters/variant-rm-lock.ts). Variants of one product share a formulation,
 * so `RM2` has to mean the same revision for every pack size of it.
 *
 * Applies uniformly to every new (non-backfilled) Recipe regardless of path —
 * the "new-version" branch of app/api/v1/masters/recipe-master/route.ts
 * (wizard/edit) and createRecipeVersion in lib/approvals/handlers/recipe.ts
 * (the variant fan-out and the CSV bulk upload) both route through here.
 */

export type DiffableLine = {
  /** 'sku' is a gift kit's component — see lib/masters/kit-sku.ts. */
  mtrl_type: "rm" | "pm" | "sku"
  mtrl_id: number
  amount: number | string
  uom?: string | null
}

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

/**
 * The two version numbers in a `<sku>-RM<n>-PM<n>` code, and the ONE place that
 * decides them — because the two sides count on different lineages:
 *
 *   RM is FAMILY-scoped. Variants of one product are the same formulation in
 *   different pack sizes, so `RM2` has to mean "revision 2 of this product's
 *   formulation" for every member. Counting it per SKU meant a variant whose
 *   first recipe was created AFTER the base had already moved to RM2 was
 *   stamped RM1 — the same formulation carrying two different version numbers,
 *   which is exactly what the version is supposed to rule out.
 *
 *   PM is SKU-scoped. A 50ml carton is genuinely not a 100ml carton, so PM
 *   revisions are counted against this SKU's own prior recipe and nothing else.
 *
 * Pass `familyRm` as null for a SKU in no variant family (or a family where
 * nobody has a recipe yet) — RM then falls back to the same per-SKU count, which
 * is correct when there is no family lineage to join.
 */
export function resolveRecipeVersions(opts: {
  /** This SKU's immediately-prior recipe, or null for its first. */
  prior: { rm_version: number; pm_version: number } | null
  /** That prior recipe's lines. Empty when there is no prior. */
  priorLines: DiffableLine[]
  /** The lines being submitted now (RM and PM together). */
  newLines: DiffableLine[]
  /** The family's current RM lineage: its version, and the RM lines AT that
   *  version. From rmLineageHead() in lib/masters/variant-rm-lock.ts. */
  familyRm: { version: number; lines: DiffableLine[] } | null
}): { rmVersion: number; pmVersion: number } {
  const { prior, priorLines, newLines, familyRm } = opts

  // PM: always this SKU's own lineage.
  const { pmChanged } = diffBomLines(priorLines, newLines)
  const pmVersion = !prior || pmChanged ? (prior?.pm_version ?? 0) + 1 : prior.pm_version

  if (familyRm) {
    // RM: the family's lineage. Submitting the family's current RM unchanged —
    // which is all a locked variant can ever do — REUSES its version rather
    // than minting a new one. Only a real change to the formulation bumps it.
    const rmChangedVsFamily = diffBomLines(familyRm.lines, newLines).rmChanged
    return { rmVersion: rmChangedVsFamily ? familyRm.version + 1 : familyRm.version, pmVersion }
  }

  const { rmChanged } = diffBomLines(priorLines, newLines)
  return {
    rmVersion: !prior || rmChanged ? (prior?.rm_version ?? 0) + 1 : prior.rm_version,
    pmVersion,
  }
}

/**
 * The stored `bom_code`, and the ONE place its shape is decided.
 *
 *   ordinary   `<sku>-RM<n>-PM<n>`     MCaf208_WB-RM1-PM1
 *   gift kit   `<sku>_KIT_PM<n>`       MGKIT62_ACG_S_KIT_PM1
 *
 * A kit is assembled from finished SKUs and has no formulation (route.ts 400s
 * an RM line on one as `kit_has_rm`), so it carries no RM segment: the `RM1` it
 * used to show named lines it did not have, and could never advance —
 * `resolveRecipeVersions` bumps RM only when the RM set changes, and an empty
 * set never differs from an empty set. `_KIT_` marks the shape so a kit's code
 * is recognisable on sight rather than only by the absent segment.
 *
 * Keyed on the lines rather than on isKitSku so the code cannot disagree with
 * its own contents; a non-kit always has at least one RM line (`rm_required`),
 * so only a kit can reach the kit form.
 *
 * Fits `master_recipe.bom_code` VARCHAR(50): the longest live kit SKU code is
 * 18 chars, leaving ~27 with the suffix.
 */
export function recipeCode(
  skuCode: string,
  versions: { rmVersion: number; pmVersion: number },
  lines: DiffableLine[]
): string {
  const hasRm = lines.some((l) => l.mtrl_type === "rm")
  return hasRm
    ? `${skuCode}-RM${versions.rmVersion}-PM${versions.pmVersion}`
    : `${skuCode}_KIT_PM${versions.pmVersion}`
}

/**
 * Compares the RM-line set and PM-line set independently — any addition, removal,
 * or amount/uom change on a side marks that side changed.
 *
 * ── A GIFT KIT'S CONTENTS COUNT AS A PM-SIDE CHANGE ──────────────────────────
 * `'sku'` lines are folded into `pmChanged`, not given a version of their own.
 *
 * They cannot simply be ignored: a kit has no RM and no PM, so a version that
 * swapped one component for another would show NEITHER side changed, `pm_version`
 * would not bump, and two recipes with different contents would carry the SAME
 * `<sku>-RM<n>-PM<n>` code. "Same version number, different content" is exactly the
 * integrity hole rm_version exists to close for formulations.
 *
 * PM is the right side to fold into: composition is SKU-scoped, precisely as PM is
 * (a 7-piece gift set is not a 3-piece one), while RM is family-scoped and shared.
 * The alternative — a third `-SK<n>` segment — would change a user-visible
 * identifier and every place that reads or displays it, to encode the same fact.
 *
 * `rmChanged` is deliberately left alone by 'sku' lines, so a kit never triggers
 * the variant fan-out: it has no formulation to propagate to anybody.
 */
export function diffBomLines(
  oldLines: DiffableLine[],
  newLines: DiffableLine[]
): { rmChanged: boolean; pmChanged: boolean } {
  const oldRm = new Set(oldLines.filter((l) => l.mtrl_type === "rm").map(lineKey))
  const newRm = new Set(newLines.filter((l) => l.mtrl_type === "rm").map(lineKey))
  // PM and 'sku' share a set on purpose — see the note above. They can never
  // collide: lineKey is prefixed with mtrl_type.
  const pmSide = (l: DiffableLine) => l.mtrl_type === "pm" || l.mtrl_type === "sku"
  const oldPm = new Set(oldLines.filter(pmSide).map(lineKey))
  const newPm = new Set(newLines.filter(pmSide).map(lineKey))

  const setsDiffer = (a: Set<string>, b: Set<string>) =>
    a.size !== b.size || [...a].some((k) => !b.has(k))

  return {
    rmChanged: setsDiffer(oldRm, newRm),
    pmChanged: setsDiffer(oldPm, newPm),
  }
}
