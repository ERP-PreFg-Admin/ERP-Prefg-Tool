import { NextResponse } from "next/server"
import { execute, pool, query } from "@/lib/db"
import { skus as skuSql } from "@/lib/queries/skus"
import { approvalsSql } from "@/lib/queries/approvals"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { parseS3Import } from "@/lib/import-s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { skuActionSchema } from "@/lib/validation/skus"

export const POST = withGateway({
  schema: skuActionSchema,
  access: { pageSlug: "/masters/skus", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // ── create ──────────────────────────────────────────────────────────────────
    if (body.action === "create") {
      const sku_code = body.sku_code.trim()
      const name = body.name.trim()
      const { brand, category, status } = body

      const eventId = makeEventId("SKU", "create")
      const logCtx = { ...ctx, eventId, module: "SKU_CREATE" }
      logger.info({ ...logCtx, sku_code, name, message: "SKU create started" })
      recordRawEvent("SKU", eventId, { sku_code, name, brand, category, status })

      try {
        const result = await execute(skuSql.insertSku, [
          sku_code,
          name,
          brand?.trim() || null,
          category?.trim() || null,
          status || "active",
          userId,
        ])
        recordProcessedEvent("SKU", eventId, { id: result.insertId })
        logger.info({ ...logCtx, id: result.insertId, message: "SKU created" })
        return NextResponse.json({ id: result.insertId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        recordFailedEvent("SKU", eventId, { sku_code, name }, message)
        if (code === "ER_DUP_ENTRY") {
          logger.warn({ ...logCtx, sku_code, message: "Duplicate SKU code" })
          throw new ApiError(409, "duplicate", `SKU code "${sku_code}" already exists`)
        }
        logger.error({ ...logCtx, error: message, code, message: "SKU create failed" })
        throw new ApiError(500, "internal", "Database error")
      }
    }

    // ── bulk (client-side CSV) ───────────────────────────────────────────────────
    if (body.action === "bulk") {
      const { rows } = body

      const eventId = makeEventId("SKU_BULK", "bulk")
      const logCtx = { ...ctx, eventId, module: "SKU_BULK" }
      logger.info({ ...logCtx, rowCount: rows.length, message: "SKU bulk insert started" })
      recordRawEvent("SKU_BULK", eventId, { source: "csv", rowCount: rows.length })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      let inserted = 0
      let skipped = 0

      try {
        for (const row of rows) {
          if (!row.sku_code?.trim?.() || !row.name?.trim?.()) continue
          try {
            await conn.execute(skuSql.insertSku, [
              row.sku_code.trim(),
              row.name.trim(),
              row.brand?.trim() || null,
              row.category?.trim() || null,
              row.status || "active",
              userId,
            ])
            inserted++
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code
            if (code === "ER_DUP_ENTRY") {
              skipped++
            } else {
              throw err
            }
          }
        }
        await conn.commit()
        recordProcessedEvent("SKU_BULK", eventId, { source: "csv", inserted, skipped })
        logger.info({ ...logCtx, inserted, skipped, message: "SKU bulk insert committed" })
        return NextResponse.json({ inserted, skipped })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        await conn.rollback()
        recordFailedEvent("SKU_BULK", eventId, { source: "csv", rowCount: rows.length }, message)
        logger.error({ ...logCtx, error: message, code, message: "SKU bulk insert failed" })
        throw new ApiError(500, "internal", "Bulk insert failed: " + message)
      } finally {
        conn.release()
      }
    }

    // ── update (approval flow) ───────────────────────────────────────────────────
    if (body.action === "update") {
      const { id, category, subcategory, sku_type, filling, filling_uom, mrp, status, remarks } = body

      const eventId = makeEventId("SKU_UPDATE", "update", id)
      const logCtx = { ...ctx, eventId, module: "SKU_UPDATE" }

      const pending = await query(approvalsSql.hasPending, ["SKU", id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, id, message: "SKU update blocked: pending approval exists" })
        throw new ApiError(
          409,
          "pending_approval",
          "This SKU has a pending approval. Wait for it to be resolved before editing again."
        )
      }

      logger.info({ ...logCtx, id, message: "SKU update (approval) started" })
      recordRawEvent("SKU_UPDATE", eventId, { id })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        type SkuRow = { id: number; sku_code: string; name: string; brand: string | null; category: string | null; status: string; [key: string]: unknown }
        const [rows] = await conn.execute(skuSql.selectById, [id])
        const current = (rows as SkuRow[])[0]
        if (!current) {
          logger.warn({ ...logCtx, id, message: "SKU not found" })
          throw new ApiError(404, "not_found", "SKU not found")
        }

        // name/brand aren't part of this edit dialog's fields — fall back to
        // the current record so they never spuriously show up in the diff.
        const name = body.name?.trim() || current.name
        const brand = body.brand?.trim() ?? current.brand ?? ""

        const proposed: Record<string, string> = {
          name,
          brand: brand || "",
          category: category?.trim() || "",
          subcategory: subcategory?.trim() || "",
          sku_type: sku_type?.trim() || "",
          filling: filling != null && filling !== "" ? String(filling) : "",
          filling_uom: filling_uom?.trim() || "",
          mrp: mrp != null && mrp !== "" ? String(mrp) : "",
          status: status || "active",
        }
        const diff = Object.entries(proposed).filter(
          ([k, v]) => String(current[k] ?? "") !== String(v ?? "")
        )

        // A rejected SKU's fields still hold its pre-rejection values (reject
        // never applies the diff, only flips status) — so resubmitting the
        // exact same values legitimately has an empty diff. Without this,
        // that resubmit would silently no-op instead of raising a fresh
        // approval. Mirrors vendors/route.ts + manufacturers/route.ts.
        const isDraftResubmit = diff.length === 0 && current.status === "rejected"
        if (diff.length === 0 && !isDraftResubmit) {
          await conn.rollback()
          logger.info({ ...logCtx, id, message: "SKU update: no changes detected" })
          return NextResponse.json({ ok: true, message: "No changes detected" })
        }

        const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [userId, "SKU", id, "edit"])
        const approvalId = (approvalResult as { insertId: number }).insertId

        const itemsToRecord = isDraftResubmit
          ? Object.entries(proposed).filter(([, v]) => v !== "")
          : diff
        for (const [field, newVal] of itemsToRecord) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId,
            field,
            isDraftResubmit ? "" : String(current[field] ?? ""),
            String(newVal ?? ""),
          ])
        }

        await conn.execute(skuSql.setStatus, ["in_review", id])
        await insertHistoryEntry(conn, {
          module: "SKU",
          entityId: Number(id),
          actionType: "edit",
          remarks: remarks.trim(),
          createdBy: userId,
        })
        await conn.commit()

        recordProcessedEvent("SKU_UPDATE", eventId, { id, approvalId })
        logger.info({ ...logCtx, id, approvalId, message: "SKU update submitted for approval" })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        await conn.rollback()
        recordFailedEvent("SKU_UPDATE", eventId, { id }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, id, error: message, code, message: "SKU update (approval) failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── bulk_from_s3 ─────────────────────────────────────────────────────────────

    if(body.action === "bulk_from_s3") {
      const { key } = body
      const eventId = makeEventId("SKU_BULK", "bulk-s3")
      const logCtx = { ...ctx, eventId, module: "SKU_S3BULK" }

      let rawRows
      try {
        rawRows = await parseS3Import(key)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ ...logCtx, s3Key: key, error: message, message: "SKU S3 bulk: failed to parse file" })
        throw new ApiError(400, "parse_error", "Failed to parse file: " + message)
      }

      if (rawRows.length === 0) {
        logger.warn({ ...logCtx, s3Key: key, message: "SKU S3 bulk: file empty or no data rows" })
        throw new ApiError(400, "empty_file", "File is empty or has no data rows")
      }

      logger.info({ ...logCtx, s3Key: key, rowCount: rawRows.length, message: "SKU S3 bulk import started" })
      recordRawEvent("SKU_BULK", eventId, { source: "s3", s3Key: key, rowCount: rawRows.length })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      let inserted = 0
      let skipped = 0

      try {
        for (const row of rawRows) {
          const sku_code = row["sku_code"]?.trim()
          const name = row["name"]?.trim()
          if (!sku_code || !name) continue
          try {
            await conn.execute(skuSql.insertSku, [
              sku_code,
              name,
              row["brand"]?.trim() || null,
              row["category"]?.trim() || null,
              row["status"]?.trim() || "active",
              userId,
            ])
            inserted++
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code
            if (code === "ER_DUP_ENTRY") {
              skipped++
            } else {
              throw err
            }
          }
        }
        await conn.commit()
        recordProcessedEvent("SKU_BULK", eventId, { source: "s3", s3Key: key, inserted, skipped })
        logger.info({ ...logCtx, s3Key: key, inserted, skipped, message: "SKU S3 bulk import committed" })
        return NextResponse.json({ inserted, skipped })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        await conn.rollback()
        recordFailedEvent("SKU_BULK", eventId, { source: "s3", s3Key: key }, message)
        logger.error({ ...logCtx, s3Key: key, error: message, code, message: "SKU S3 bulk import failed" })
        throw new ApiError(500, "internal", "Import failed: " + message)
      } finally {
        conn.release()
      }
    }

    // ── variants (same brand + base_sku_sno family) ──────────────────────────────
    if (body.action === "variants") {
      const { brand, base_sku_sno } = body
      const rows = await query(skuSql.selectVariantsByBrandAndSno, [brand, base_sku_sno])
      return NextResponse.json({ skus: rows })
    }

    logger.warn({...ctx , message: "Invalid action"})
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }

})
