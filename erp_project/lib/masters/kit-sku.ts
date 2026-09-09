/**
 * Is this SKU a gift kit — a SKU assembled from other SKUs rather than made from
 * raw material?
 *
 * ONE definition, because it is asked on both sides of the trust boundary: the
 * recipe wizard reads it off the `Sku` row it already has to decide what to show,
 * and `create-full` re-resolves it from the database row to decide what to accept.
 * The client is never believed about it — same reason the route re-resolves
 * `resolveRmLock` instead of trusting the greyed-out RM grid.
 *
 * ── Why both columns ─────────────────────────────────────────────────────────
 * `sku_type = 'Gift Kit'` alone is not enough. On prod (2026-09-09) seven SKUs
 * carry it; six are real kits (`subcategory = 'Kit'`, `filling_uom = 'units'`,
 * `filling` = the component count) and the seventh, MCaf208_WB, is a 200 ml body
 * wash somebody mistyped. Testing `sku_type` alone would offer that body wash a
 * component list and hide the RM formulation it actually needs.
 *
 * Both columns are free-text `varchar` with autocomplete-from-distinct-values in
 * the SKU editor (`ManagedFuzzyField`), NOT enums — so the comparison is trimmed
 * and case-insensitive. Someone will type "gift kit".
 *
 * Pure module: no React, no lib/db, so tests/unit can reach it.
 */

/** The `master_skus` columns that decide it. Structural, so a full `Sku` row, a
 *  narrow SELECT and a test fixture all satisfy it. */
export type KitSkuFields = {
  sku_type?: string | null
  subcategory?: string | null
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()

export const KIT_SKU_TYPE = "gift kit"
export const KIT_SUBCATEGORY = "kit"

export function isKitSku(sku: KitSkuFields | null | undefined): boolean {
  if (!sku) return false
  return norm(sku.sku_type) === KIT_SKU_TYPE && norm(sku.subcategory) === KIT_SUBCATEGORY
}

/**
 * The unit of a kit's component line.
 *
 * A component is counted, never measured — `master_skus.filling_uom` is already
 * 'units' on every real kit, and `filling` is how many. Fixed rather than read off
 * the row so a kit whose `filling_uom` was left blank still writes a sensible line.
 */
export const KIT_LINE_UOM = "units"

/**
 * How many units the SKU master says this kit holds — `master_skus.filling` — or
 * null when nobody has filled it in.
 *
 * This is the CAP on the contents, not a hint: see kitUnitsExceeded.
 */
export function declaredKitUnits(sku: { filling?: number | string | null } | null | undefined): number | null {
  const raw = sku?.filling
  if (raw === null || raw === undefined || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The units a contents list adds up to. Amounts arrive as strings from the
 *  form and as DECIMAL strings from the database, hence Number() on each. */
export function kitUnitsTotal(lines: { amount: number | string }[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
}

/**
 * Is this contents list bigger than the kit is declared to hold?
 *
 * `master_skus.filling` is the kit's unit count — a 3-unit kit is a box with three
 * things in it — so four units of contents describes a kit that does not exist.
 * This is the RM total's counterpart for the other recipe shape, and it is an
 * UPPER BOUND only:
 *
 *   over  ⇒ refused. The pack cannot hold it, and every downstream reader (the
 *           warehouse picking it, any future cost roll-up) would be wrong.
 *   under ⇒ allowed, with a warning. A kit part-way through being specified is a
 *           normal state, and refusing it would make the recipe unsaveable
 *           until someone finished it in a different screen.
 *
 * Null `declared` means the SKU master has no count, so there is nothing to cap
 * against and anything is allowed.
 */
export function kitUnitsExceeded(total: number, declared: number | null): boolean {
  return declared != null && total > declared
}

/** The one wording for an over-capacity kit, so the client and the route cannot
 *  quote different numbers — the same reason rmTotalMessage exists. */
export function kitUnitsMessage(total: number, declared: number): string {
  return `This kit is declared to hold ${declared} unit${declared === 1 ? "" : "s"}, ` +
    `but the contents add up to ${total}. Remove ${total - declared} or change Filling on the SKU.`
}
