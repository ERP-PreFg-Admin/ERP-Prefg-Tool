// POST /api/v1/manufacturing/facility-map
//
// The write side of the MFG × Facility matrix on /po-tracking/mfg-overview.
// Table: un_code_mfg_sku_wh_map — one row per (facility, mfg, SKU), plus a
// `sku_id IS NULL` row per pair carrying that pair's Uniware vendor code.
//
//   { action: "set-vendor-code", mfg_id, wh_id, un_mfg_code, remarks? }
//     Records that this manufacturer IS a Uniware vendor at this facility. Must
//     come first — un_mfg_code is NOT NULL on every row, so there is nothing to
//     write a SKU mapping with until it exists. This is the grey → pink transition.
//     Response 200 { ok } · 409 (code already another mfg's here) · 404
//
//   { action: "set-map", mfg_id, wh_id, sku_codes[] }
//     Replaces the whole mapped-SKU set for that pair — upsert the ticked ones,
//     deactivate the rest. sku_codes may be empty (untick everything).
//     Response 200 { ok, mapped, unmapped } · 409 (no vendor code yet) · 404
//
// No approval flow, matching its own parent: app/api/v1/manufacturing/lines
// /route.ts:5 — "master_recipe_mfg isn't a registered approval module". Nothing
// prices off the facility dimension, and ~300 cells of mechanical mapping would
// bury the rate changes people actually read /approvals for. The audit trail is
// withGateway's activity_log row plus created_by/updated_by on each row.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { facilityMapActionSchema } from "@/lib/validation/manufacturing"
import { mfgFacilityMap } from "@/lib/queries/mfg-facility-map"
import { getUserScope, assertInScope, type UserScope } from "@/lib/scope"
import { assertSkuCodesInBrandScope } from "@/lib/brand-guard"
import { pushFacilityMap } from "@/lib/mfg-facility-push"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"

// One vendor item is one HTTP call to Unicommerce, and a cell can carry a hundred
// SKUs. Rows not reached before the budget runs out stay un_pushed_at NULL and are
// picked up by Retry, so a timeout costs time rather than correctness.
export const maxDuration = 300

type FacilityRow = {
  id: number
  facility_code: string | null
  wh_name: string
  entity_code: string
}

/**
 * Resolve a facility id and check it against the caller's warehouse scope.
 *
 * `wh_id` arrives from the client as a small consecutive integer, so it is
 * guessable — the same reason lib/po-guard.ts exists for PO ids. And the scope's
 * warehouse dimension is NAMES, not ids (purchase_orders.destination stores the
 * name), so the id has to be resolved before it can be checked at all. Without
 * this a warehouse-scoped user can map into any facility by incrementing a number.
 */
async function assertFacilityInScope(scope: UserScope, whId: number): Promise<FacilityRow> {
  const rows = await query<FacilityRow>(mfgFacilityMap.selectFacilityById, [whId])
  const facility = rows[0]
  if (!facility) throw new ApiError(404, "facility_not_found", "Facility not found")
  assertInScope(scope, "warehouse", facility.wh_name)
  return facility
}

/** This pair's Uniware vendor code, or null when the pair has no rows yet. */
async function vendorCodeFor(mfgId: number, whId: number): Promise<string | null> {
  const rows = await query<{ un_mfg_code: string | null }>(
    mfgFacilityMap.selectVendorCode,
    [whId, mfgId]
  )
  return rows[0]?.un_mfg_code?.trim() || null
}

export const POST = withGateway({
  schema: facilityMapActionSchema,
  access: { pageSlug: "/manufacturing", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    const scope = await getUserScope(userId)

    // Every guard runs before any write, and in this order: cheapest first, and
    // the facility lookup has to precede the brand check so a bad wh_id 404s
    // rather than leaking which SKUs exist.
    assertInScope(scope, "mfg", body.mfg_id)
    const facility = await assertFacilityInScope(scope, body.wh_id)

    // ── retry-push ───────────────────────────────────────────────────────────
    // Writes nothing locally; only re-attempts Uniware for rows already mapped.
    if (body.action === "retry-push") {
      const push = await pushFacilityMap(body.mfg_id, body.wh_id)
      return NextResponse.json({ ok: true, push })
    }

    // ── set-vendor-code ──────────────────────────────────────────────────────
    if (body.action === "set-vendor-code") {
      const code = body.un_mfg_code.trim()
      const eventId = makeEventId("MFG_FACILITY_CODE", "set", `${body.mfg_id}-${body.wh_id}`)
      const logCtx = { ...ctx, eventId, module: "MFG_FACILITY_CODE" }
      recordRawEvent("MFG_FACILITY_CODE", eventId, { mfgId: body.mfg_id, whId: body.wh_id, code })

      // ⚠️ The guard that used to be the uq_wh_code UNIQUE index, dropped by
      // prisma/alter_un_code_mfg_sku_wh_map.sql for the re-grain. Two of our
      // manufacturers sharing one Uniware vendor code at one facility means POs
      // and inwards land against the wrong ledger, and nothing downstream would
      // notice. Pinned by tests/db/mfg-facility-map.test.ts.
      const clash = await query<{ mfg_code: string; mfg_name: string }>(
        mfgFacilityMap.selectVendorCodeConflict,
        [body.wh_id, code, body.mfg_id]
      )
      if (clash.length > 0) {
        throw new ApiError(
          409, "vendor_code_taken",
          `Uniware vendor code '${code}' is already ${clash[0].mfg_name} (${clash[0].mfg_code}) ` +
          `at ${facility.wh_name} · ${facility.entity_code}. One code identifies one vendor per ` +
          `facility — inwarding would land against the wrong manufacturer.`
        )
      }

      const conn: PoolConnection = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [existing] = await conn.execute(mfgFacilityMap.selectVendorCodeRow, [body.mfg_id, body.wh_id])
        const has = (existing as unknown[]).length > 0

        if (has) {
          await conn.execute(mfgFacilityMap.updateVendorCodeRow, [
            code, body.remarks?.trim() || null, userId, body.mfg_id, body.wh_id,
          ])
        } else {
          await conn.execute(mfgFacilityMap.insertVendorCodeRow, [
            body.mfg_id, body.wh_id, code, body.remarks?.trim() || null, userId, userId,
          ])
        }

        // un_mfg_code is denormalised across the pair's SKU rows, so a change has
        // to reach all of them — the matrix reads it with MAX() and would
        // otherwise return whichever copy sorted highest.
        await conn.execute(mfgFacilityMap.syncVendorCodeOnSkuRows, [
          code, userId, body.mfg_id, body.wh_id,
        ])

        await conn.commit()
        logger.info({ ...logCtx, mfgId: body.mfg_id, whId: body.wh_id, code, message: "Facility vendor code set" })
        recordProcessedEvent("MFG_FACILITY_CODE", eventId, { mfgId: body.mfg_id, whId: body.wh_id })
        return NextResponse.json({ ok: true, un_mfg_code: code })
      } catch (err: unknown) {
        await conn.rollback()
        if (err instanceof ApiError) throw err
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ ...logCtx, err: message, message: "Facility vendor code failed" })
        recordFailedEvent("MFG_FACILITY_CODE", eventId, { mfgId: body.mfg_id, whId: body.wh_id }, message)
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── set-map ──────────────────────────────────────────────────────────────
    const codes = [...new Set(body.sku_codes.map((c) => c.trim()).filter(Boolean))]
    const eventId = makeEventId("MFG_FACILITY_MAP", "set", `${body.mfg_id}-${body.wh_id}`)
    const logCtx = { ...ctx, eventId, module: "MFG_FACILITY_MAP" }
    recordRawEvent("MFG_FACILITY_MAP", eventId, { mfgId: body.mfg_id, whId: body.wh_id, count: codes.length })

    // A write against these SKUs' brands. Runs on the submitted codes, so a user
    // cannot map a SKU outside their brand grant even though the matrix row is
    // one they can see.
    await assertSkuCodesInBrandScope(userId, codes, scope)

    // un_mfg_code is NOT NULL, so there is literally no value to write a SKU row
    // with until the pair has a vendor code. Surfacing that as a readable 409 is
    // also the UI's grey-cell story: set the code first.
    const vendorCode = await vendorCodeFor(body.mfg_id, body.wh_id)
    if (!vendorCode) {
      throw new ApiError(
        409, "vendor_code_missing",
        `Set the Uniware vendor code for ${facility.wh_name} · ${facility.entity_code} before ` +
        `mapping SKUs — Uniware identifies this manufacturer by that code at this facility.`
      )
    }

    // Resolve codes to ids in one round trip. A code that resolves to nothing is
    // reported rather than silently dropped: on a matrix Save it would mean the
    // client and the DB disagree about what exists, which is worth knowing.
    let skuIds: number[] = []
    if (codes.length > 0) {
      const rows = await query<{ id: number; sku_code: string }>(mfgFacilityMap.skuIdsByCodes, [codes])
      const found = new Set(rows.map((r) => r.sku_code))
      const missing = codes.filter((c) => !found.has(c))
      if (missing.length > 0) {
        throw new ApiError(400, "unknown_sku", `Unknown SKU code(s): ${missing.join(", ")}`)
      }
      skuIds = rows.map((r) => r.id)
    }

    // ── Append-only ──────────────────────────────────────────────────────────
    // Mapping ADDS; it never withdraws. Unicommerce has no way to un-map a vendor
    // item, so a mapping this app retracted would still be live there — the two
    // systems would disagree and only the export would ever reveal it.
    //
    // So the ticked set is treated as "these should be mapped", not "only these
    // should be mapped", and anything already mapped is left exactly as it is.
    //
    // Filtering to genuinely-new SKUs is also what protects the push state:
    // buildUpsertMappings resets un_pushed_at/un_push_error on a duplicate key, so
    // re-sending an already-synced SKU would blank its confirmation and make a row
    // Uniware already has look like it still needs pushing.
    const existing = await query<{ sku_id: number }>(
      mfgFacilityMap.selectMappedSkuIds, [body.mfg_id, body.wh_id]
    )
    const already = new Set(existing.map((r) => r.sku_id))
    const toAdd = skuIds.filter((id) => !already.has(id))

    if (toAdd.length === 0) {
      return NextResponse.json({ ok: true, added: 0, message: "No new SKUs to map" })
    }

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      await conn.execute(
        mfgFacilityMap.buildUpsertMappings(toAdd.length),
        toAdd.flatMap((skuId) => [body.mfg_id, body.wh_id, skuId, vendorCode, userId, userId])
      )
      await conn.commit()
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...logCtx, err: message, message: "Facility SKU map failed" })
      recordFailedEvent("MFG_FACILITY_MAP", eventId, { mfgId: body.mfg_id, whId: body.wh_id }, message)
      throw new ApiError(500, "internal", "Database error")
    } finally {
      conn.release()
    }

    logger.info({ ...logCtx, mfgId: body.mfg_id, whId: body.wh_id, added: toAdd.length, message: "Facility SKU map extended" })
    recordProcessedEvent("MFG_FACILITY_MAP", eventId, { mfgId: body.mfg_id, whId: body.wh_id, added: toAdd.length })

    // ── Uniware, last ────────────────────────────────────────────────────────
    // Deliberately OUTSIDE the transaction block above, on both counts:
    //   • after commit, because Unicommerce cannot delete a vendor item, so this
    //     is the least reversible step and must not be able to lose the local
    //     mapping (least-reversible-last, as lib/invoice-inward.ts orders it);
    //   • outside that try, because its catch maps anything to a 500 — a Uniware
    //     failure must not fail a request whose database work already succeeded.
    // pushFacilityMap never throws for a business failure; the per-row
    // un_pushed_at / un_push_error state is the record, and the panel retries.
    const push = await pushFacilityMap(body.mfg_id, body.wh_id)
    return NextResponse.json({ ok: true, added: toAdd.length, push })
  },
})
