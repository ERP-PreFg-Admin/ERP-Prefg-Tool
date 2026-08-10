// API route for Manufacturers → table `mfgs`.
//
// Called by ManufacturersClient's AddRecordDialog / CsvImportDialog
// (endpoint="/api/v1/masters/manufacturers"). On success the client refreshes the
// page, re-running ManufacturersPage's SELECT.
//
// POST /api/v1/masters/manufacturers
//   Request  { action: "create", name, ... }
//     Process → auto-generate code (MFG-<serial>-<XX>) + INSERT one manufacturer.
//     Response 200 { ok, approval_id } · 400 (validation, via withGateway) · 500 { error }
//
//   Request  { action: "bulk", rows: [{ name, ... }, ...] }
//     Process → rows recognized as an edit of an existing manufacturer (see
//       resolveMfgBulkRows) are submitted immediately as their own real MFG
//       approval — same insertApproval/insertApprovalItem/setStatus sequence
//       as the single-record "update" action, so each shows up (with a real
//       field diff) in that manufacturer's History dialog right away. Rows
//       that don't match anything are new records: bundled together and
//       staged as ONE pending "MFG_BULK" approval (S3 file, nothing inserted
//       into master_mfgs until an admin approves — see MFG_BULK's handler in
//       lib/approvals/module-handlers.ts). `approval_id` in the response is
//       whichever of these got created (arbitrary if both did — it's only
//       used client-side as a truthy "this went through approval" signal).
//     Response 200 { ok, approval_id, staged, skipped, total } · 500 { error }
//
//   Request  { action: "bulk_from_s3", key }
//     Process → same split staging behaviour as "bulk", but the file is
//       already in S3 — just parsed, no second upload for the create rows.
//     Response 200 { ok, approval_id, staged, skipped, total } · 500 { error }
//
//   Request  { action: "update_docs", mfg_id, gst_certificate_key?, cancelled_cheque_key?, pan_card_key?, misc_document_key? }
//     Process → computes diff of the 4 doc key columns; submits MFG approval (same flow as "update").
//       Files are already uploaded to S3 by the client before calling this endpoint.
//     Response 200 { ok, approval_id } · 409 (pending approval) · 500 { error }
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
// `mfgs.code` is UNIQUE; the generator retries the next serial on a collision.
import { NextResponse } from "next/server"
import type { ResultSetHeader } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { manufacturers } from "@/lib/queries/manufacturers"
import { approvalsSql } from "@/lib/queries/approvals"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { parseS3Import } from "@/lib/import-s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { mfgActionSchema } from "@/lib/validation/manufacturers"
import { assertNoDuplicateBankingFields, insertMfgWithGeneratedCode } from "@/lib/master-routes/material-utils"
import { type EditCandidate, findBestEditMatch, fetchEditMatchCandidates } from "@/lib/master-routes/edit-match"
import { stageMfgBulkRows } from "@/lib/approvals/handlers/manufacturers"
import { monthIST } from "@/lib/date"

type MfgDetailRow = {
  id: number; mfg_id: number; status: string; location: string | null
  gst_number: string | null; registered_name: string | null; zone: string | null
  bank_name: string | null; ifsc_number: string | null; account_number: string | null
  email: string | null; gst_certificate_key: string | null; cancelled_cheque_key: string | null
  pan_card_key: string | null; misc_document_key: string | null; code: string; name: string
  [key: string]: unknown
}

export const POST = withGateway({
  schema: mfgActionSchema,
  access: { pageSlug: "/masters/manufacturers", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // ── create (approval flow) ───────────────────────────────────────────────────
    if (body.action === "create") {
      const name = body.name.trim()
      const { location, gst_number, registered_name, zone, bank_name, ifsc_number, account_number, email,
              gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key } = body

      const eventId = makeEventId("MFG", "create")
      const logCtx = { ...ctx, eventId, module: "MFG_CREATE" }
      logger.info({ ...logCtx, name, message: "Manufacturer create started" })
      recordRawEvent("MFG", eventId, { name })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        await assertNoDuplicateBankingFields(conn, manufacturers, { gst_number, ifsc_number, account_number }, 0)

        const { mfgId, code } = await insertMfgWithGeneratedCode(conn, manufacturers.insert, manufacturers.countTotal, name)
        logger.info({ ...logCtx, mfgId, code, message: "Manufacturer created" })

        await conn.execute(manufacturers.insertDetails, [
          mfgId,
          location?.trim() || null,
          gst_number?.trim() || null,
          "in_review",
          registered_name?.trim() || null,
          zone?.trim() || null,
          bank_name?.trim() || null,
          ifsc_number?.trim() || null,
          account_number?.trim() || null,
          email?.trim() || null,
        ])
        logger.info({ ...logCtx, mfgId, message: "Creating approval record in database" })
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "MFG", mfgId, "create"])
        const approvalId = (ar as ResultSetHeader).insertId
        const newFields: [string, string][] = [
          ["code", code],
          ["name", name],
          ["registered_name", registered_name?.trim() || ""],
          ["location", location?.trim() || ""],
          ["zone", zone?.trim() || ""],
          ["gst_number", gst_number?.trim() || ""],
          ["bank_name", bank_name?.trim() || ""],
          ["ifsc_number", ifsc_number?.trim() || ""],
          ["account_number", account_number?.trim() || ""],
          ["email", email?.trim() || ""],
          ["gst_certificate_key",  gst_certificate_key  ?? ""],
          ["cancelled_cheque_key", cancelled_cheque_key ?? ""],
          ["pan_card_key",         pan_card_key         ?? ""],
          ["misc_document_key",    misc_document_key    ?? ""],
        ]
        for (const [field, newVal] of newFields) {
          if (newVal) {
            await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", newVal])
            logger.debug({ ...logCtx, mfgId, approvalId, field, message: "Approval item inserted" })
          }
        }
        logger.debug({ ...logCtx, mfgId, approvalId, message: "All approval items inserted" })
        await conn.commit()
        logger.info({ ...logCtx, mfgId, approvalId, message: "Transaction committed successfully" })
        recordProcessedEvent("MFG", eventId, { mfgId, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        logger.warn({ ...logCtx, message: "Transaction rolled back" })
        recordFailedEvent("MFG", eventId, { name }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Manufacturer create failed with unexpected error" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── bulk (client-side CSV) ───────────────────────────────────────────────────
    // Edits are submitted as their own real MFG approvals immediately; new
    // records are bundled into ONE pending "MFG_BULK" approval — nothing is
    // inserted into master_mfgs for those until an admin approves (see the
    // MFG_BULK handler in lib/approvals/module-handlers.ts). See the doc
    // comment at the top of this file for why edits are split out.
    if (body.action === "bulk") {
      const { rows } = body
      const eventId = makeEventId("MFG_BULK", "bulk")
      const logCtx = { ...ctx, eventId, module: "MFG_BULK" }
      logger.info({ ...logCtx, rowCount: rows.length, message: "Manufacturer bulk upload started" })
      recordRawEvent("MFG_BULK", eventId, { source: "csv", rowCount: rows.length })

      const conn = await pool.getConnection()
      let staged = 0
      let skipped = 0
      try {
        await conn.beginTransaction()
        const s3Folder = `imports/manufacturers/${monthIST()}`
        const result = await stageMfgBulkRows(conn, rows, userId, s3Folder)
        staged = result.staged
        skipped = result.skipped

        if (staged === 0) {
          throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
        }
        await conn.commit()

        logger.info({ ...logCtx, approvalId: result.approvalId, staged, skipped, message: "Manufacturer bulk upload staged for approval" })
        recordProcessedEvent("MFG_BULK", eventId, { source: "csv", staged, skipped, approvalId: result.approvalId })
        return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rows.length })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        logger.warn({ ...logCtx, staged, skipped, message: "Transaction rolled back" })
        recordFailedEvent("MFG_BULK", eventId, { source: "csv", rowCount: rows.length }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, err: message, stack, message: "Manufacturer bulk upload failed" })
        throw new ApiError(500, "internal", "Bulk upload failed: " + message)
      } finally {
        conn.release()
      }
    }

    // ── check_duplicates (read-only CSV-preview helper) ─────────────────────────
    if (body.action === "check_duplicates") {
      const { rows } = body
      const duplicates: Record<number, string[]> = {}
      // A row whose `code` cell matches an existing manufacturer's business
      // code isn't a "duplicate" error — it's treated as an edit of that
      // record (see resolveMfgBulkRows). No code means the row is always a
      // new record.
      const editMatches: Record<number, { id: number; code: string; current: EditCandidate }> = {}

      const candidates = await fetchEditMatchCandidates<EditCandidate>(
        manufacturers.selectCandidatesByCodesBatch, rows
      )

      rows.forEach((row: Record<string, unknown>, i: number) => {
        const match = findBestEditMatch(row, candidates)
        if (match) editMatches[i] = { id: match.id, code: match.code, current: match }
      })

      const fieldChecks: [string, string, string][] = [
        ["gst_number", manufacturers.checkDuplicateGstBatch, "GST number"],
        ["ifsc_number", manufacturers.checkDuplicateIfscBatch, "IFSC code"],
        ["account_number", manufacturers.checkDuplicateAccountNumberBatch, "Account number"],
        ["email", manufacturers.checkDuplicateEmailBatch, "Email"],
      ]

      for (const [field, sql, label] of fieldChecks) {
        const values = [...new Set(
          rows.map((r: Record<string, unknown>) => String(r[field] ?? "").trim()).filter(Boolean)
        )]
        if (values.length === 0) continue

        const matches = await query<{ code: string; value: string }>(sql, [values])
        if (matches.length === 0) continue
        const codeByValue = new Map(matches.map((m) => [m.value, m.code]))

        rows.forEach((row: Record<string, unknown>, i: number) => {
          // A row already recognized as an edit-of-existing-record (by name)
          // legitimately reuses its own GST/IFSC/account — don't flag those.
          if (editMatches[i]) return
          const val = String(row[field] ?? "").trim()
          const code = val && codeByValue.get(val)
          if (code) {
            ;(duplicates[i] ??= []).push(`${label} "${val}" is already used by ${code}`)
          }
        })
      }

      return NextResponse.json({ duplicates, editMatches })
    }

    // ── update_docs (approval flow) ──────────────────────────────────────────────
    if (body.action === "update_docs") {
      const { mfg_id, gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key } = body
      const eventId = makeEventId("MFG_DOCS", "docs", mfg_id)
      const logCtx = { ...ctx, eventId, module: "MFG_DOCS" }

      const pending = await query(approvalsSql.hasPending, ["MFG", mfg_id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, mfg_id, message: "Doc update blocked — pending approval exists" })
        throw new ApiError(409, "pending_approval", "This manufacturer has a pending approval. Wait for it to be resolved before uploading documents.")
      }

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        const [rows] = await conn.execute(manufacturers.selectById, [mfg_id])
        const current = (rows as MfgDetailRow[])[0]
        if (!current) {
          await conn.rollback()
          throw new ApiError(404, "not_found", "Manufacturer not found")
        }

        const proposed: Record<string, string> = {
          gst_certificate_key:  String(gst_certificate_key  ?? ""),
          cancelled_cheque_key: String(cancelled_cheque_key ?? ""),
          pan_card_key:         String(pan_card_key         ?? ""),
          misc_document_key:    String(misc_document_key    ?? ""),
        }

        const diff = Object.entries(proposed).filter(
          ([k, v]) => String(current[k] ?? "") !== v
        )

        if (diff.length === 0) {
          await conn.rollback()
          return NextResponse.json({ ok: true, message: "No changes detected" })
        }

        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "MFG", mfg_id, "edit"])
        const approvalId = (ar as ResultSetHeader).insertId
        for (const [field, newVal] of diff) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId, field, String(current[field] ?? ""), newVal,
          ])
        }
        await conn.execute(manufacturers.setStatus, ["in_review", mfg_id])
        await conn.commit()

        logger.info({ ...logCtx, mfg_id, approvalId, message: "Manufacturer documents submitted for approval" })
        recordProcessedEvent("MFG_DOCS", eventId, { mfg_id, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_DOCS", eventId, { mfg_id: String(mfg_id) }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, mfg_id, err: message, stack, message: "Manufacturer document approval submission failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── update (approval flow) ───────────────────────────────────────────────────
    if (body.action === "update") {
      const { mfg_id, name, location, gst_number, status, registered_name, zone, bank_name, ifsc_number, account_number, email, remarks } = body

      const eventId = makeEventId("MFG_UPDATE", "update", mfg_id)
      const logCtx = { ...ctx, eventId, module: "MFG_UPDATE" }

      const pending = await query(approvalsSql.hasPending, ["MFG", mfg_id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, mfg_id, message: "Update blocked due to pending approval" })
        throw new ApiError(
          409,
          "pending_approval",
          "This manufacturer has a pending approval. Wait for it to be resolved before editing again."
        )
      }

      const conn = await pool.getConnection()
      logger.info({ ...logCtx, mfg_id, name, message: "Manufacturer update started" })
      recordRawEvent("MFG_UPDATE", eventId, { code: mfg_id, name: name.trim() })

      await conn.beginTransaction()
      try {
        const [rows] = await conn.execute(manufacturers.selectById, [mfg_id])
        const current = (rows as MfgDetailRow[])[0]

        if (!current) {
          await conn.rollback()
          logger.warn({ ...logCtx, mfg_id, message: "Manufacturer not found" })
          throw new ApiError(404, "not_found", "Manufacturer not found")
        }

        await assertNoDuplicateBankingFields(conn, manufacturers, { gst_number, ifsc_number, account_number }, Number(mfg_id))

        const proposed: Record<string, string> = {
          name: name.trim(),
          location: location?.trim() || "",
          gst_number: gst_number?.trim() || "",
          registered_name: registered_name?.trim() || "",
          zone: zone?.trim() || "",
          bank_name: bank_name?.trim() || "",
          ifsc_number: ifsc_number?.trim() || "",
          account_number: account_number?.trim() || "",
          email: email?.trim() || "",
          status: status || "active",
        }

        const diff = Object.entries(proposed).filter(
          ([k, v]) => String(current[k] ?? "") !== String(v ?? "")
        )

        const isDraftResubmit = diff.length === 0 && current.status === "rejected"

        if (diff.length === 0 && !isDraftResubmit) {
          await conn.rollback()
          return NextResponse.json({ ok: true, message: "No changes detected" })
        }
        const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [userId, "MFG", mfg_id, "edit"])
        const approvalId = (approvalResult as ResultSetHeader).insertId
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
        await conn.execute(manufacturers.setStatus, ["in_review", mfg_id])
        await insertHistoryEntry(conn, {
          module: "MFG",
          entityId: Number(mfg_id),
          actionType: "edit",
          remarks: remarks.trim(),
          createdBy: userId,
        })
        await conn.commit()
        logger.info({ ...logCtx, mfg_id, approvalId, message: "Manufacturer update submitted for approval" })

        recordProcessedEvent("MFG_UPDATE", eventId, { mfg_id, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        recordFailedEvent("MFG_UPDATE", eventId, { code: String(mfg_id), name: name.trim() }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, mfg_id, err: message, stack, message: "Manufacturer update failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── bulk_from_s3 ─────────────────────────────────────────────────────────────
    // Same staging-only behaviour as "bulk" above — the file is already in S3,
    // so we just parse it for a preview count and stage ONE approval.
    if(body.action === "bulk_from_s3") {
      const { key } = body
      const eventId = makeEventId("MFG_BULK", "bulk-csv")
      const logCtx = { ...ctx, eventId, module: "MFG_BULK" }

      let rawRows
      try {
        rawRows = await parseS3Import(key)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ ...logCtx, message: "Failed to parse the File." })
        throw new ApiError(400, "parse_error", "Failed to parse file: " + message)
      }

      if (rawRows.length === 0) {
        logger.debug({ ...logCtx, message: "File is empty or has no data." })
        throw new ApiError(400, "empty_file", "File is empty or has no data rows")
      }
      logger.info({ ...logCtx, rowCount: rawRows.length, message: "Manufacturer bulk upload (S3) started" })
      recordRawEvent("MFG_BULK", eventId, { source: "s3", s3Key: key, rowCount: rawRows.length })

      const conn = await pool.getConnection()
      let staged = 0
      let skipped = 0
      try {
        await conn.beginTransaction()
        // Uploading just the create rows to a fresh S3 key — MFG_BULK's
        // staged file must only ever contain new records (see the "bulk"
        // action above), so stageMfgBulkRows can't reuse `key` as-is (the
        // originally-uploaded file has every row, edits included).
        const s3Folder = `imports/manufacturers/${monthIST()}`
        const result = await stageMfgBulkRows(conn, rawRows, userId, s3Folder)
        staged = result.staged
        skipped = result.skipped

        if (staged === 0) {
          throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
        }
        await conn.commit()

        logger.info({ ...logCtx, approvalId: result.approvalId, staged, skipped, message: "Manufacturer bulk upload (S3) staged for approval" })
        recordProcessedEvent("MFG_BULK", eventId, { source: "s3", s3Key: key, staged, skipped, approvalId: result.approvalId })
        return NextResponse.json({ ok: true, approval_id: result.approvalId, staged, skipped, total: rawRows.length })
      } catch (err: unknown) {
        await conn.rollback()
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        logger.warn({ ...logCtx, staged, skipped, message: "Transaction rolled back" })
        recordFailedEvent("MFG_BULK", eventId, { source: "s3", s3Key: key }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, err: message, stack, message: "Manufacturer bulk upload (S3) failed" })
        throw new ApiError(500, "internal", "Import failed: " + message)
      } finally {
        conn.release()
      }
    }

    logger.warn({...ctx , message: "Invalid action"})
    return NextResponse.json({error:"Invalid action"} , {status : 400})
  },
})
