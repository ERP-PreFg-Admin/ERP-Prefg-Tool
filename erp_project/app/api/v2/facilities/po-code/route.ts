// GET  /api/v2/facilities/po-code
// POST /api/v2/facilities/po-code   { facility_id, po_short_code?, po_seq_seed? }
//
// Read and write the per-facility segment of the ERP-minted Uniware PO code —
// M/MUM1/2627/01234. Table: details_warehouse_entity (po_short_code, po_seq_seed).

import { NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import { facilityPoCodeSchema } from "@/lib/validation/warehouses"
import { getUserScope, assertInScope, type UserScope } from "@/lib/scope"
import { poLetterForEntity } from "@/lib/constants"
import { financialYearToken, poCodePartsFor, buildUniwarePoCode } from "@/lib/uniware/po-code"

type PoConfigRow = {
  id: number
  facility_code: string | null
  po_short_code: string | null
  po_seq_seed: number | null
  wh_name: string
  location?: string | null
  entity_code: string
}


async function assertFacilityInScope(scope: UserScope, id: number): Promise<PoConfigRow> {
  const rows = await query<PoConfigRow>(warehouseSql.selectPoConfigById, [id])
  const facility = rows[0]
  if (!facility) throw new ApiError(404, "facility_not_found", "Facility not found")
  assertInScope(scope, "warehouse", facility.wh_name)
  return facility
}

export const GET = withGateway({
  access: { pageSlug: "/masters/warehouses", level: "viewer" },
  handler: async ({ session }) => {
    const scope = await getUserScope(Number(session.user.id))
    const rows = await query<PoConfigRow>(warehouseSql.selectPoConfigs, [])
    const fy = financialYearToken()

    const facilities = rows
      .filter((r) => {
        try { assertInScope(scope, "warehouse", r.wh_name); return true } catch { return false }
      })
      .map((r) => {
        const parts = poCodePartsFor(r, poLetterForEntity)
        return {
          ...r,
          letter: poLetterForEntity(r.entity_code),
          fy,
          next_code: parts ? buildUniwarePoCode(parts, Number(r.po_seq_seed ?? 0) + 1) : null,
          configured: parts !== null,
        }
      })

    return NextResponse.json({ fy, facilities })
  },
})

export const POST = withGateway({
  access: { pageSlug: "/masters/warehouses", level: "editor" },
  schema: facilityPoCodeSchema,
  handler: async ({ body, session }) => {
    const scope = await getUserScope(Number(session.user.id))
    const facility = await assertFacilityInScope(scope, body.facility_id)
    const shortCode = body.po_short_code?.trim() ? body.po_short_code.trim() : null
    const seed = shortCode === null ? null : (body.po_seq_seed ?? null)

    if (shortCode && !poLetterForEntity(facility.entity_code)) {
      throw new ApiError(
        400, "entity_unmapped",
        `No PO-code letter is mapped for entity '${facility.entity_code}'. ` +
        `Add it to ENTITY_PO_LETTER in lib/constants.ts first.`
      )
    }

    try {
      await execute(warehouseSql.updatePoConfig, [shortCode, seed, facility.id])
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
        throw new ApiError(
          409, "short_code_taken",
          `Short code '${shortCode}' is already used by another ${facility.entity_code} facility.`
        )
      }
      throw err
    }

    const parts = poCodePartsFor({ ...facility, po_short_code: shortCode }, poLetterForEntity)
    return NextResponse.json({
      ok: true,
      facility_id: facility.id,
      po_short_code: shortCode,
      po_seq_seed: seed,
      next_code: parts ? buildUniwarePoCode(parts, Number(seed ?? 0) + 1) : null,
    })
  },
})
