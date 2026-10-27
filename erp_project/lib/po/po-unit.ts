// Which manufacturer unit a new PO is raised against. Pure: the caller loads the mfg's active units
// and the SKU's mapped default. Shared by Add PO, the bulk upload and its approval.

export type MfgUnitOption = { id: number; unit_code: string }

export type UnitResolution =
  | { ok: true; unitId: number | null }
  | { ok: false; code: "unit_not_applicable" | "unknown_unit" | "unit_required"; message: string }

/** `chosen` is a unit id (dialog) or unit code (CSV); blank takes the SKU's mapped default. */
export function resolvePoUnit(
  units: MfgUnitOption[],
  defaultUnitId: number | null,
  chosen: number | string | null | undefined,
): UnitResolution {
  const picked = chosen === null || chosen === undefined ? "" : String(chosen).trim()
  if (units.length === 0) {
    return picked
      ? { ok: false, code: "unit_not_applicable", message: "This manufacturer has no units to choose from" }
      : { ok: true, unitId: null }
  }
  if (picked) {
    const unit = typeof chosen === "number"
      ? units.find((u) => u.id === chosen)
      : units.find((u) => u.unit_code.toLowerCase() === picked.toLowerCase())
    if (!unit) {
      return { ok: false, code: "unknown_unit", message: `"${picked}" is not a unit of this manufacturer (${units.map((u) => u.unit_code).join(", ")})` }
    }
    return { ok: true, unitId: unit.id }
  }
  if (defaultUnitId !== null && units.some((u) => u.id === defaultUnitId)) return { ok: true, unitId: defaultUnitId }
  return { ok: false, code: "unit_required", message: `Pick the supplier unit (${units.map((u) => u.unit_code).join(", ")})` }
}
