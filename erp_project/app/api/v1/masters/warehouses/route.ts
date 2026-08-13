// API route for Warehouses → tables `master_warehouse` + `details_warehouse_entity`.
//
// Called by WarehousesClient's Add/Edit dialogs. On success the client refreshes
// the page, re-running WarehousesPage's SELECT.
//
// POST /api/v1/masters/warehouses
//   Request  { action: "create", name, location, state?, zone, type, entities? }
//     Process → INSERT the location as in_review + its per-entity rows, then one
//       WAREHOUSE approval with an item per field (old_value "") so
//       isNewRecord() renders it as a New-record card.
//     Response 200 { ok, approval_id } · 409 (duplicate name) · 400 (validation)
//
//   Request  { action: "update", id, location, state?, zone, type, status?, entities?, remarks }
//     Process → the canonical CLAUDE.md approval pattern: hasPending guard →
//       diff against selectById → insert approval + items → setStatus(in_review).
//     Response 200 { ok, approval_id } · 409 (pending approval) · 404
//
// `name` is absent from the update schema on purpose: purchase_orders.destination,
// invoice_mfg.destination and entity_emails.entity_code are unenforced VARCHAR
// copies of it, so a rename orphans all three silently.
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
import { NextResponse } from "next/server"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import { approvalsSql } from "@/lib/queries/approvals"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { warehouseActionSchema, type WarehouseEntityRow } from "@/lib/validation/warehouses"
import { panOf } from "@/lib/gstin"
import { STATUS } from "@/lib/constants"

/** Child-row fields the approval diff carries. Must stay in step with
 *  ENTITY_FIELDS in lib/approvals/handlers/warehouses.ts — this writes the diff,
 *  that reads it, and a field in one but not the other is silently dropped. */
const ENTITY_FIELDS = [
  "facility_code", "type", "remarks",
  "bill_to_gstin", "bill_to_name", "bill_to_address",
  "ship_to_gstin", "ship_to_name",
  "ship_to_line1", "ship_to_line2", "ship_to_city", "ship_to_state", "ship_to_pincode",
  "ship_to_address",
] as const

/** Location fields other than `name`, which is immutable. */
const MASTER_FIELDS = [
  "code", "location", "state", "zone", "type", "contact_person", "contact_phone", "site_gstin",
] as const

/** `facility_code` for entity PEP becomes the diff item `facility_code:PEP`. */
const entityField = (field: string, entityCode: string) => `${field}:${entityCode}`

const str = (v: unknown) => (v == null ? "" : String(v).trim())

/**
 * Resolve every submitted entity block to a real master_entity row, and validate
 * its two GSTINs — which follow DIFFERENT rules.
 *
 * bill_to_gstin is who we bill, so its PAN must be this entity's. The Edit dialog
 * shows both entities' sections side by side with identical field names, and
 * pasting Pep's registration into Kreative's slot yields a GSTIN that is
 * perfectly valid and genuinely ours — isOurs() accepts it and nothing downstream
 * notices. This is the only thing that catches it.
 *
 * ship_to_gstin is the CONSIGNEE, which is whoever operates the site. Pep runs
 * most of them, so Kreative's Kolkata, Bengaluru, Ahmedabad, Nagpur and Guwahati
 * rows ship under Pep's registration for that state. It must be one of OUR PANs,
 * but checking it against the row's own entity would reject correct data.
 *
 * Neither check can live in the Zod schema: both need master_entity.
 */
async function resolveEntities(
  conn: PoolConnection,
  rows: WarehouseEntityRow[] | undefined
): Promise<{ row: WarehouseEntityRow; entityId: number; code: string }[]> {
  const [allEnt] = await conn.execute(warehouseSql.entityOptions)
  const ourPans = new Set(
    (allEnt as { pan: string | null }[]).map((e) => e.pan).filter((p): p is string => Boolean(p))
  )

  const out: { row: WarehouseEntityRow; entityId: number; code: string }[] = []
  for (const row of rows ?? []) {
    const [entRows] = await conn.execute(warehouseSql.selectEntityIdByCode, [row.entity_code])
    const entity = (entRows as { id: number; code: string; pan: string | null }[])[0]
    if (!entity) {
      throw new ApiError(400, "unknown_entity", `Unknown legal entity '${row.entity_code}'.`)
    }

    const billTo = str(row.bill_to_gstin)
    if (billTo && entity.pan && panOf(billTo) !== entity.pan) {
      throw new ApiError(
        400, "bill_to_gstin_entity_mismatch",
        `Bill-to GSTIN ${billTo} belongs to PAN ${panOf(billTo)}, but it was entered under ` +
        `${entity.code} (PAN ${entity.pan}). Check which entity's section it goes in.`
      )
    }

    const shipTo = str(row.ship_to_gstin)
    if (shipTo && ourPans.size > 0 && !ourPans.has(panOf(shipTo))) {
      throw new ApiError(
        400, "ship_to_gstin_not_ours",
        `Ship-to GSTIN ${shipTo} belongs to PAN ${panOf(shipTo)}, which is not one of our ` +
        `registered entities. It does not have to be ${entity.code}'s — most sites are operated ` +
        `by Pep — but it must be one of ours.`
      )
    }

    out.push({ row, entityId: entity.id, code: entity.code })
  }
  return out
}

export const POST = withGateway({
  schema: warehouseActionSchema,
  access: { pageSlug: "/masters/warehouses", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // ── create (approval flow) ───────────────────────────────────────────────
    if (body.action === "create") {
      const name = body.name.trim()
      const eventId = makeEventId("WAREHOUSE", "create")
      const logCtx = { ...ctx, eventId, module: "WAREHOUSE_CREATE" }
      logger.info({ ...logCtx, name, message: "Warehouse create started" })
      recordRawEvent("WAREHOUSE", eventId, { name })

      // Pre-check for a readable 409 instead of ER_DUP_ENTRY on uq_warehouse_name.
      const existing = await query<{ id: number }>(warehouseSql.selectByNameForDup, [name])
      if (existing.length > 0) {
        throw new ApiError(409, "duplicate_name", `A warehouse named '${name}' already exists.`)
      }

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const entities = await resolveEntities(conn, body.entities)

        const [insRes] = await conn.execute(warehouseSql.insert, [
          // `code` is UNIQUE, so blank must be NULL — '' would collide with the
          // next warehouse left without a code.
          str(body.code) || null,
          name,
          body.location.trim(),
          str(body.state) || null,
          body.zone.trim(),
          body.type,
          str(body.contact_person) || null,
          str(body.contact_phone) || null,
          str(body.site_gstin) || null,
          STATUS.IN_REVIEW,
          userId,
        ])
        const warehouseId = (insRes as ResultSetHeader).insertId

        for (const { row, entityId } of entities) {
          await conn.execute(warehouseSql.upsertEntityRow, [
            warehouseId, entityId,
            str(row.facility_code) || null,
            // "" means "inherit the location's type", which is NULL in the column.
            str(row.type) || null,
            str(row.bill_to_gstin) || null,
            str(row.bill_to_name) || null,
            str(row.bill_to_address) || null,
            str(row.ship_to_gstin) || null,
            str(row.ship_to_name) || null,
            str(row.ship_to_line1) || null,
            str(row.ship_to_line2) || null,
            str(row.ship_to_city) || null,
            str(row.ship_to_state) || null,
            str(row.ship_to_pincode) || null,
            str(row.ship_to_address) || null,
            row.status ?? STATUS.ACTIVE,
            str(row.remarks) || null,
          ])
        }

        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "WAREHOUSE", warehouseId, "create"])
        const approvalId = (ar as ResultSetHeader).insertId

        const newFields: [string, string][] = [
          ["name", name],
          ...MASTER_FIELDS.map((f): [string, string] => [f, str(body[f])]),
        ]
        for (const { row, code } of entities) {
          for (const field of ENTITY_FIELDS) {
            newFields.push([entityField(field, code), str(row[field])])
          }
        }
        // Only non-empty values become items — an empty one would render as a
        // "" -> "" no-op row on the approval card.
        for (const [field, newVal] of newFields) {
          if (newVal) await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", newVal])
        }

        await insertHistoryEntry(conn, {
          module: "WAREHOUSE", entityId: warehouseId, actionType: "create",
          remarks: null, createdBy: userId,
        })

        await conn.commit()
        logger.info({ ...logCtx, warehouseId, approvalId, message: "Warehouse created, pending approval" })
        recordProcessedEvent("WAREHOUSE", eventId, { warehouseId, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        if (err instanceof ApiError) throw err
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ ...logCtx, err: message, message: "Warehouse create failed" })
        recordFailedEvent("WAREHOUSE", eventId, { name }, message)
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── update (approval flow) ───────────────────────────────────────────────
    const { id, remarks } = body
    const eventId = makeEventId("WAREHOUSE_UPDATE", "update", id)
    const logCtx = { ...ctx, eventId, module: "WAREHOUSE_UPDATE" }

    const pending = await query(approvalsSql.hasPending, ["WAREHOUSE", id])
    if (pending.length > 0) {
      throw new ApiError(
        409, "pending_approval",
        "This warehouse has a pending approval. Wait for it to be resolved before editing again."
      )
    }

    const conn = await pool.getConnection()
    await conn.beginTransaction()
    recordRawEvent("WAREHOUSE_UPDATE", eventId, { id })
    try {
      const [rows] = await conn.execute(warehouseSql.selectById, [id])
      const current = (rows as Record<string, unknown>[])[0]
      if (!current) {
        await conn.rollback()
        throw new ApiError(404, "not_found", "Warehouse not found")
      }

      const entities = await resolveEntities(conn, body.entities)

      // `name` is absent — see the header note. Everything else is comparable.
      const proposed: Record<string, string> = {
        ...Object.fromEntries(MASTER_FIELDS.map((f) => [f, str(body[f])])),
        status: body.status || STATUS.ACTIVE,
      }

      // Child rows diff against their own current values, keyed by entity code so
      // the approval card reads unambiguously.
      for (const { row, code } of entities) {
        const [curRows] = await conn.execute(warehouseSql.selectEntityRowByCode, [id, code])
        const cur = (curRows as Record<string, unknown>[])[0] ?? {}
        for (const field of ENTITY_FIELDS) {
          proposed[entityField(field, code)] = str(row[field])
          current[entityField(field, code)] = str(cur[field])
        }
      }

      const diff = Object.entries(proposed).filter(
        ([k, v]) => String(current[k] ?? "") !== String(v ?? "")
      )

      // A rejected record can be re-submitted unchanged — that is the submitter
      // asking for another look, not a no-op.
      const isRejectedResubmit = diff.length === 0 && current.status === STATUS.REJECTED
      if (diff.length === 0 && !isRejectedResubmit) {
        await conn.rollback()
        return NextResponse.json({ ok: true, message: "No changes detected" })
      }

      const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "WAREHOUSE", id, "edit"])
      const approvalId = (ar as ResultSetHeader).insertId
      for (const [field, newVal] of diff) {
        await conn.execute(approvalsSql.insertApprovalItem, [
          approvalId, field, String(current[field] ?? ""), String(newVal),
        ])
      }

      await insertHistoryEntry(conn, {
        module: "WAREHOUSE", entityId: Number(id), actionType: "edit",
        remarks: remarks.trim(), createdBy: userId,
      })
      await conn.execute(warehouseSql.setStatus, [STATUS.IN_REVIEW, id])

      await conn.commit()
      logger.info({ ...logCtx, id, approvalId, changed: diff.length, message: "Warehouse edit submitted" })
      recordProcessedEvent("WAREHOUSE_UPDATE", eventId, { id, approvalId })
      return NextResponse.json({ ok: true, approval_id: approvalId })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...logCtx, err: message, message: "Warehouse update failed" })
      recordFailedEvent("WAREHOUSE_UPDATE", eventId, { id }, message)
      throw new ApiError(500, "internal", "Database error")
    } finally {
      conn.release()
    }
  },
})
