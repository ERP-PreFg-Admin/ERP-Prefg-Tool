// GatePass facility roster, read from Warehouse Master so added or deactivated facilities follow it.

import { query } from "@/lib/db"
import { ApiError } from "@/lib/gateway/errors"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"

/** Gatepass-only facilities, asked for by ops 2026-11-03; they are not in Warehouse Master. */
const EXTRA_GATEPASS_FACILITIES = ["mCaff_Kolkata3", "mCaff_Gurgaon3", "mCaff_Mumbai2"]

export async function getGatepassFacilities(): Promise<string[]> {
  const rows = await query<{ facility_code: string }>(warehouseSql.selectGatepassFacilities, [])
  return [...new Set([...rows.map((r) => r.facility_code), ...EXTRA_GATEPASS_FACILITIES])]
}

/** The routes' guard: never forward a code to Uniware that isn't on the roster. */
export async function assertGatepassFacility(code: string): Promise<void> {
  if (!(await getGatepassFacilities()).includes(code)) {
    throw new ApiError(400, "unknown_facility", `${code} is not an active CWH facility in Warehouse Master or a gatepass-only facility.`)
  }
}
