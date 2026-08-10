import { NextResponse } from "next/server"
import type { ResultSetHeader } from "mysql2/promise"
import { query, pool } from "@/lib/db"
import { rawMaterials } from "@/lib/queries/raw-materials"
import { packingMaterials as PMMaterials } from "@/lib/queries/packing-materials"
import { approvalsSql } from "@/lib/queries/approvals"
import logger from "@/lib/logger"
import { recordRawEvent, recordFailedEvent, recordProcessedEvent, makeEventId } from "@/lib/events"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { materialMasterCreateSchema, materialMasterUpdateSchema } from "@/lib/validation/material-master"
import { generateMaterialCode } from "@/lib/master-routes/material-utils"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"

type RmBaseRow = {
  id: number; rm_code: string; name: string; make: string; type: string | null
  uom: string | null; status: string; hsn_code: string | null; inci_name: string
  [key: string]: unknown
}
type PmBaseRow = {
  id: number; pm_code: string; name: string; type: string; uom: string | null
  status: string; hsn_code: string | null; pantone_color: string | null
  [key: string]: unknown
}

// ─── POST: create a base material record (no vendor / manufacturer rates) ────
// Body: { action: "create", material: "rm" | "pm", ...fields }
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).

export const POST = withGateway({
  schema: materialMasterCreateSchema,
  access: { pageSlug: "/masters/material-master", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    if (body.material === "rm") {
      const name = body.name.trim()
      const make = body.make.trim()
      const inci_name = body.inci_name.trim()
      const { type, uom, hsn_code } = body

      const eventId = makeEventId("RM_MAT", "create")
      const logCtx = { ...ctx, eventId, module: "RM_MAT" }
      logger.info({ ...logCtx, name, make, inci_name, message: "Raw material create started" })
      recordRawEvent("RM_MAT", eventId, { name, make, inci_name })
      const dupRows = await query<{ id: number }>(rawMaterials.checkDuplicate, [name, make, inci_name])

      if (dupRows.length > 0) {
        logger.warn({ ...logCtx, name, make, inci_name, message: "Duplicate raw material found" })
        throw new ApiError(409, "duplicate", "A raw material with this code already exists.")
      }
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const rmCode = await generateMaterialCode(conn, rawMaterials.countTotal, "RM", name, make)
        const [rmResult] = await conn.execute(rawMaterials.insert, [
          rmCode,
          name,
          make,
          type?.trim() || null,
          uom?.trim() || null,
          "in_review",
          hsn_code?.trim() || null,
          inci_name,
        ])
        const rmId = (rmResult as ResultSetHeader).insertId
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "RM_MAT", rmId, "create"])
        const approvalId = (ar as ResultSetHeader).insertId
        const newFields: [string, string][] = [
          ["rm_code", rmCode],
          ["name", name],
          ["make", make],
          ["inci_name", inci_name],
          ["type", type?.trim() || ""],
          ["uom", uom?.trim() || ""],
          ["hsn_code", hsn_code?.trim() || ""],
        ]
        for (const [field, newVal] of newFields) {
          if (newVal) {
            await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", newVal])
          }
        }
        await conn.commit()
        recordProcessedEvent("RM_MAT", eventId, { rmId, approvalId })
        logger.info({ ...logCtx, rmId, approvalId, message: "Raw material created successfully" })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("RM_MAT", eventId, { name }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Raw material create failed" })
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }

    // material === "pm"
    if(body.material === "pm") {
      const name = body.name.trim()
      const type = body.type.trim()
      const { uom, hsn_code } = body

      const eventId = makeEventId("PM", "create")
      const logCtx = { ...ctx, eventId, module: "PM" }

      logger.info({ ...logCtx, name, type, message: "Packing material create started" })
      recordRawEvent("PM", eventId, { name, type })

      const dupRows = await query<{ id: number }>(PMMaterials.checkDuplicate, [name, type])

      if (dupRows.length > 0) {
        logger.warn({ ...logCtx, name, type, message: "Duplicate packing material found" })
        throw new ApiError(409, "duplicate", "A packing material with this code already exists.")
      }

      const pantone_color = body.pantone_color?.trim() || null

      const conn = await pool.getConnection()
      await conn.beginTransaction()

      try {
        const pmCode = await generateMaterialCode(conn, PMMaterials.countTotal, "PM")
        const [pmResult] = await conn.execute(PMMaterials.insert, [
          pmCode,
          name,
          type,
          hsn_code?.trim() || null,
          uom?.trim() || null,
          "in_review",
          pantone_color,
        ])

        const pmId = (pmResult as ResultSetHeader).insertId

        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PM_MAT", pmId, "create"])

        const approvalId = (ar as ResultSetHeader).insertId

        const newFields: [string, string][] = [
          ["pm_code", pmCode],
          ["name", name],
          ["type", type],
          ["uom", uom?.trim() || ""],
          ["hsn_code", hsn_code?.trim() || ""],
          ["pantone_color", pantone_color ?? ""],
        ]

        for (const [field, newVal] of newFields) {
          if (newVal) {
            await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", newVal])
          }
        }

        await conn.commit()
        recordProcessedEvent("PM", eventId, { pmId, approvalId })
        logger.info({ ...logCtx, pmId, approvalId, message: "Packing material created successfully" })

        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("PM", eventId, { name, type }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Packing material create failed" })
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }

    return NextResponse.json({ error: "Invalid material type" }, { status: 400 })
  },
})

// ─── PUT: submit an edit for approval ────────────────────────────────────────
//
// Instead of writing directly to the DB, this creates an approval record with
// a field-level diff and locks the row to "in_review". The approver then
// applies or rejects the change via POST /api/v1/approvals/[id].

export const PUT = withGateway({
  schema: materialMasterUpdateSchema,
  access: { pageSlug: "/masters/material-master", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    const { id } = body

    if (body.material === "rm") {
      const name = body.name.trim()
      const make = body.make.trim()
      const inci_name = body.inci_name.trim()
      const { type, uom, status, hsn_code } = body

      const eventId = makeEventId("RM_UPDATE", "update", id)
      const logCtx = { ...ctx, eventId, module: "RM_UPDATE" }
      logger.info({ ...logCtx, id, name, make, inci_name, message: "Raw material update started" })
      const curRows = await query<RmBaseRow>(rawMaterials.selectBaseById, [id])
      const cur = curRows[0]
      if (!cur) {
        logger.warn({ ...logCtx, id, message: "Raw material not found" })
        throw new ApiError(404, "not_found", "Record not found.")
      }
      if (cur.status === "in_review") {
        logger.warn({ ...logCtx, id, message: "Raw material already pending approval" })
        throw new ApiError(409, "pending_approval", "This record is already pending approval.")
      }
      // For rejected rows, only the original submitter may re-edit.
      if (cur.status === "rejected") {
        const rejRows = await query<{ raised_by: number }>(approvalsSql.selectLatestRejection, ["RM_MAT", id])
        if (rejRows[0] && rejRows[0].raised_by !== userId) {
          logger.warn({ ...logCtx, id, userId, message: "Unauthorized rejected-record edit attempt" })
          throw new ApiError(403, "forbidden", "Only the original submitter can re-edit a rejected record.")
        }
      }
      const pending = await query(approvalsSql.hasPending, ["RM_MAT", id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, id, message: "Approval already pending for raw material" })
        throw new ApiError(409, "pending_approval", "An approval is already pending for this record.")
      }
      recordRawEvent("RM_UPDATE", eventId, { id, name })
      const proposed: Record<string, string | null> = {
        name,
        make,
        inci_name,
        type: type?.trim() || null,
        uom: uom?.trim() || null,
        hsn_code: hsn_code?.trim() || null,
        status: status || "active",
      }
      const diff = Object.entries(proposed).filter(
        ([k, v]) => String(cur[k] ?? "") !== String(v ?? "")
      )
      if (diff.length === 0) {
        logger.warn({ ...logCtx, message: "No changes detected." })
        return NextResponse.json({ ok: true, message: "No changes detected." })
      }
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "RM_MAT", id, "edit"])
        const approvalId = (ar as ResultSetHeader).insertId
        for (const [field, newVal] of diff) {
          await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, String(cur[field] ?? ""), String(newVal ?? "")])
        }
        await conn.execute(rawMaterials.setBaseStatus, ["in_review", id])
        await insertHistoryEntry(conn, {
          module: "RM_MAT",
          entityId: Number(id),
          actionType: "edit",
          remarks: body.remarks.trim(),
          createdBy: userId,
        })
        await conn.commit()
        recordProcessedEvent("RM_UPDATE", eventId, { id, approvalId })
        logger.info({ ...logCtx, id, approvalId, message: "Raw material update submitted for approval" })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("RM_UPDATE", eventId, { id, name }, message)
        logger.error({ ...logCtx, id, err: message, stack, message: "Raw material update failed" })
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }

    // material === "pm"
    if (body.material === "pm") {
      const name = body.name.trim()
      const type = body.type.trim()
      const { uom, status, hsn_code } = body

      const eventId = makeEventId("PM_UPDATE", "update", id)
      const logCtx = { ...ctx, eventId, module: "PM_UPDATE" }
      logger.info({ ...logCtx, id, name, type, message: "Packing material update started" })
      const curRows = await query<PmBaseRow>(PMMaterials.selectBaseById, [id])
      const cur = curRows[0]
      if (!cur) {
        logger.warn({ ...logCtx, id, message: "Packing material not found" })
        throw new ApiError(404, "not_found", "Record not found.")
      }
      if (cur.status === "in_review") {
        logger.warn({ ...logCtx, id, message: "Packing material already pending approval" })
        throw new ApiError(409, "pending_approval", "This record is already pending approval.")
      }
      if (cur.status === "rejected") {
        const rejRows = await query<{ raised_by: number }>(approvalsSql.selectLatestRejection, ["PM_MAT", id])
        logger.info({ ...logCtx, id, userId, message: "Rejected record re-edit submitted for approval." })
        if (rejRows[0] && rejRows[0].raised_by !== userId) {
          logger.warn({ ...logCtx, id, userId, message: "Unauthorized rejected-record edit attempt" })
          throw new ApiError(403, "forbidden", "Only the original submitter can re-edit a rejected record.")
        }
      }
      const pending = await query(approvalsSql.hasPending, ["PM_MAT", id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, id, message: "Approval already pending for packing material" })
        throw new ApiError(409, "pending_approval", "An approval is already pending for this record.")
      }
      recordRawEvent("PM_UPDATE", eventId, { id, name, type })
      const proposed: Record<string, string | null> = {
        name,
        type,
        uom: uom?.trim() || null,
        hsn_code: hsn_code?.trim() || null,
        pantone_color: body.pantone_color?.trim() || null,
        status: status || "active",
      }
      const diff = Object.entries(proposed).filter(
        ([k, v]) => String(cur[k] ?? "") !== String(v ?? "")
      )
      if (diff.length === 0) {
        logger.warn({ ...logCtx, id, userId, message: "No changes detected." })
        return NextResponse.json({ ok: true, message: "No changes detected." })
      }

      const conn = await pool.getConnection()
      await conn.beginTransaction()

      try {
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "PM_MAT", id, "edit"])
        const approvalId = (ar as ResultSetHeader).insertId
        for (const [field, newVal] of diff) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId,
            field,
            String(cur[field] ?? ""),
            String(newVal ?? ""),
          ])
        }
        await conn.execute(PMMaterials.setBaseStatus, ["in_review", id])
        await insertHistoryEntry(conn, {
          module: "PM_MAT",
          entityId: Number(id),
          actionType: "edit",
          remarks: body.remarks.trim(),
          createdBy: userId,
        })
        await conn.commit()
        recordProcessedEvent("PM_UPDATE", eventId, { id, approvalId })
        logger.info({ ...logCtx, id, approvalId, message: "Packing material update submitted for approval" })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("PM_UPDATE", eventId, { id, name, type }, message)
        logger.error({ ...logCtx, id, err: message, stack, message: "Packing material update failed" })
        throw new ApiError(500, "internal", "Database error: " + message)
      } finally {
        conn.release()
      }
    }
    logger.warn({ ...ctx, message: "Invalid material type in update request" })
    return NextResponse.json({ ok: false, message: "Invalid material type." }, { status: 400 })
  }
})
