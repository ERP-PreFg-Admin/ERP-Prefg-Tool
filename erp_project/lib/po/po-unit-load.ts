// Loads what resolvePoUnit needs, through whichever executor the caller holds (pool or open connection).

import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { ApiError } from "@/lib/gateway/errors"
import { resolvePoUnit, type MfgUnitOption } from "@/lib/po/po-unit"

type Run = (sql: string, params: unknown[]) => Promise<unknown>

export async function loadPoUnitContext(run: Run, mfgId: number, skuCode: string) {
  const [units, mapped] = await Promise.all([
    run(purchaseOrdersSql.selectActiveMfgUnits, [mfgId]),
    run(purchaseOrdersSql.selectMappedMfgUnit, [mfgId, skuCode]),
  ])
  const defaultUnitId = (mapped as { unit_id: number }[])[0]?.unit_id ?? null
  return { units: units as MfgUnitOption[], defaultUnitId }
}

/** Resolves the unit for a single PO, or throws a 400 the dialog can show. */
export async function resolvePoUnitOrThrow(run: Run, mfgId: number, skuCode: string, chosen: number | string | null | undefined) {
  const { units, defaultUnitId } = await loadPoUnitContext(run, mfgId, skuCode)
  const r = resolvePoUnit(units, defaultUnitId, chosen)
  if (!r.ok) throw new ApiError(400, r.code, r.message)
  return r.unitId
}
