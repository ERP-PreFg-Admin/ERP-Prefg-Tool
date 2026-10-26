// GatePass facility roster, read from Warehouse Master so added or deactivated facilities follow it.

import { query } from "@/lib/db"
import { ApiError } from "@/lib/gateway/errors"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"

export async function getGatepassFacilities(): Promise<string[]> {
  const rows = await query<{ facility_code: string }>(warehouseSql.selectGatepassFacilities, [])
  return rows.map((r) => r.facility_code)
}

/** The routes' guard: never forward a code to Uniware that isn't an active CWH facility. */
export async function assertGatepassFacility(code: string): Promise<void> {
  if (!(await getGatepassFacilities()).includes(code)) {
    throw new ApiError(400, "unknown_facility", `${code} is not an active CWH facility in Warehouse Master.`)
  }
}
