// API route for Vendors → table `vendors`.
//
// Called by VendorsClient's AddRecordDialog / CsvImportDialog
// (endpoint="/api/masters/vendors"). On success the client refreshes the page.
//
// A vendor lives across TWO tables, linked only by id (no DB foreign key):
//   vendors(id, code, name, type)
//   details_vendor(vendor_id → vendors.id, location, status, zone, registered_name)
// So every insert is: INSERT the vendor, read its new id (result.insertId),
// then INSERT the matching details_vendor row — both inside one transaction so
// we never leave a vendor without its details (or vice-versa).
//
// POST /api/masters/vendors
//   Request  { action: "create", name, type, location?, zone?, registered_name? }
//     Process → auto-generate code (VEN-<RM/PM/BT>-<first 3 letters of name>) + INSERT vendors → INSERT details_vendor(vendor_id = new id).
//     Response 200 { ok, approval_id } · 400 (validation, via withGateway) · 500 { error }
//
//   Request  { action: "bulk", rows: [{ name, type, location?, ... }, ...] }
//     Process → rows recognized as an edit of an existing vendor (see
//       resolveVendorBulkRows) are submitted immediately as their own real
//       VENDOR approval — same insertApproval/insertApprovalItem/setStatus
//       sequence as the single-record "update" action, so each shows up
//       (with a real field diff) in that vendor's History dialog right
//       away. Rows that don't match anything are new records: bundled
//       together and staged as ONE pending "VENDOR_BULK" approval (S3 file,
//       nothing inserted into master_vendors until an admin approves — see
//       VENDOR_BULK's handler in lib/approvals/module-handlers.ts).
//       `approval_id` in the response is whichever of these got created
//       (arbitrary if both did — only used client-side as a truthy "this
//       went through approval" signal).
//     Response 200 { ok, approval_id, staged, skipped, total } · 500 { error }
//
//   Request  { action: "bulk_from_s3", key }
//     Process → same split staging behaviour as "bulk", but the file is
//       already in S3 (client uploaded it via /api/upload) — just parsed,
//       no second upload for the create rows.
//     Response 200 { ok, approval_id, staged, skipped, total } · 500 { error }
//
// Auth + body validation handled by withGateway (see lib/gateway/with-gateway.ts).
// `vendors.code` is UNIQUE; the generator (insertVendorWithGeneratedCode in lib/master-routes/material-utils.ts)
// retries with a numeric suffix (-2, -3, ...) on a collision. `type` is a NOT NULL enum, so it is required.
import { NextResponse } from "next/server"
import { pool, query } from "@/lib/db"
import { vendors } from "@/lib/queries/vendors"
import { approvalsSql } from "@/lib/queries/approvals"
import { insertHistoryEntry } from "@/lib/master-routes/history-utils"
import { parseS3Import } from "@/lib/import-s3"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { vendorActionSchema } from "@/lib/validation/vendors"
import { assertNoDuplicateBankingFields, insertVendorWithGeneratedCode } from "@/lib/master-routes/material-utils"
import { uploadRowsAsCsv, stageBulkUploadApproval } from "@/lib/master-routes/bulk-approval"
import { type EditCandidate, findBestEditMatch, fetchEditMatchCandidates } from "@/lib/master-routes/edit-match"
import { resolveVendorBulkRows, submitVendorBulkEdit } from "@/lib/approvals/handlers/vendors"

export const POST = withGateway({
  schema: vendorActionSchema,
  access: { pageSlug: "/masters/vendors", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)

    // ── create (approval flow) ───────────────────────────────────────────────────
    if (body.action === "create") {
      const name = body.name.trim()
      const type = body.type.trim()
      const { location, zone, registered_name, gst_number, bank_name, ifsc_number, account_number,
              gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key } = body

      const eventId = makeEventId("VENDOR", "create")
      const logCtx = { ...ctx, eventId, module: "VEN_Create" }
      logger.info({ ...logCtx, name, type, message: "Vendor Create Started" })
      recordRawEvent("VENDOR", eventId, { name, type })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        await assertNoDuplicateBankingFields(conn, vendors, { gst_number, ifsc_number, account_number }, 0)

        // Auto-generate code as VEN-<RM/PM/BT>-<first 3 letters of name>.
        const { vendorId, code } = await insertVendorWithGeneratedCode(conn, vendors.insertVendor, vendors.countTotal, name, type)
        logger.info({ ...logCtx, vendorId, code, message: "Vendor created." })
        await conn.execute(vendors.insertVendorDetails, [
          vendorId,
          location?.trim() || null,
          "in_review",
          zone?.trim() || null,
          registered_name?.trim() || null,
          gst_number?.trim() || null,
          bank_name?.trim() || null,
          ifsc_number?.trim() || null,
          account_number?.trim() || null,
        ])
        logger.info({ ...logCtx, vendorId, message: "Created approval record in the Database." })
        const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "VENDOR", vendorId, "create"])
        const approvalId = (ar as { insertId: number }).insertId

        const newFields: [string, string][] = [
          ["code", code],
          ["name", name],
          ["type", type],
          ["location", location?.trim() || ""],
          ["zone", zone?.trim() || ""],
          ["registered_name", registered_name?.trim() || ""],
          ["gst_number", gst_number?.trim() || ""],
          ["bank_name", bank_name?.trim() || ""],
          ["ifsc_number", ifsc_number?.trim() || ""],
          ["account_number", account_number?.trim() || ""],
          ["gst_certificate_key",  gst_certificate_key  ?? ""],
          ["cancelled_cheque_key", cancelled_cheque_key ?? ""],
          ["pan_card_key",         pan_card_key         ?? ""],
          ["misc_document_key",    misc_document_key    ?? ""],
        ]
        for (const [field, newVal] of newFields) {
          if (newVal) {
            await conn.execute(approvalsSql.insertApprovalItem, [approvalId, field, "", newVal])
            logger.debug({ ...logCtx, vendorId, approvalId, field, message: "Approval item inserted" })
          }
        }
        logger.info({ ...logCtx, vendorId, approvalId, message: "All approval items inserted" })
        await conn.commit()
        logger.info({ ...logCtx, vendorId, approvalId, message: "Transaction committed successfully" })
        recordProcessedEvent("VENDOR", eventId, { vendorId, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        await conn.rollback()
        logger.warn({ ...logCtx, message: "Transaction rolled back" })
        recordFailedEvent("VENDOR", eventId, { name }, message)
        logger.error({ ...logCtx, err: message, stack, message: "Vendor create failed with unexpected error" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── bulk (client-side CSV) ───────────────────────────────────────────────────
    // Edits are submitted as their own real VENDOR approvals immediately;
    // new records are bundled into ONE pending "VENDOR_BULK" approval —
    // nothing is inserted into master_vendors for those until an admin
    // approves (see the VENDOR_BULK handler in lib/approvals/module-handlers.ts).
    // See the doc comment at the top of this file for why edits are split out.
    if (body.action === "bulk") {
      const { rows } = body
      const eventId = makeEventId("VENDOR_BULK", "bulk")
      const logCtx = { ...ctx, eventId, module: "VENDOR_BULK" }
      logger.info({ ...logCtx, rows: rows.length, message: "Vendor bulk upload started." })
      recordRawEvent("VENDOR_BULK", eventId, { source: "csv", rowCount: rows.length })

      const conn = await pool.getConnection()
      let staged = 0
      let skipped = 0
      try {
        // Preview-only validation (no writes yet) — same skip rules used by
        // the VENDOR_BULK handler at approval time, since data may drift
        // between now and then.
        const resolved = await resolveVendorBulkRows(conn, rows)
        const createRows = resolved.filter((r) => r.action === "create").map((r) => r.row)
        const editEntries = resolved.filter((r) => r.action === "edit")
        skipped = resolved.length - createRows.length - editEntries.length

        if (createRows.length === 0 && editEntries.length === 0) {
          throw new ApiError(400, "nothing_to_stage", `All ${rows.length} row${rows.length !== 1 ? "s" : ""} were skipped — nothing to submit for approval.`)
        }

        // Uploading the new-record batch to S3 has no DB side effects, so it
        // doesn't need to happen inside the transaction below.
        const s3 = createRows.length > 0
          ? await uploadRowsAsCsv(createRows, `imports/vendors/${new Date().toISOString().slice(0, 7)}`, "vendor_bulk")
          : null

        await conn.beginTransaction()

        let editsSubmitted = 0
        let firstEditApprovalId: number | null = null
        for (const { row, existing } of editEntries) {
          const approvalId = await submitVendorBulkEdit(conn, row, existing, userId)
          if (approvalId == null) { skipped++; continue } // fell back to every current value — nothing actually changed
          editsSubmitted++
          firstEditApprovalId ??= approvalId
        }

        if (createRows.length === 0 && editsSubmitted === 0) {
          throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
        }

        let batchApprovalId: number | null = null
        if (s3) {
          batchApprovalId = await stageBulkUploadApproval(conn, {
            userId, module: "VENDOR_BULK", s3Key: s3.key, filename: s3.filename, rowCount: createRows.length,
          })
        }
        await conn.commit()

        staged = createRows.length + editsSubmitted
        const approvalId = batchApprovalId ?? firstEditApprovalId
        logger.info({ ...logCtx, approvalId, staged, skipped, message: "Vendor bulk upload staged for approval" })
        recordProcessedEvent("VENDOR_BULK", eventId, { source: "csv", staged, skipped, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId, staged, skipped, total: rows.length })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        await conn.rollback()
        logger.warn({ ...logCtx, staged, skipped, message: "Transaction rolled back" })
        recordFailedEvent("VENDOR_BULK", eventId, { source: "csv", rowCount: rows.length }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, err: message, stack, message: "Vendor bulk upload failed." })
        throw new ApiError(500, "internal", "Bulk upload failed: " + message)
      } finally {
        logger.debug({ ...logCtx, message: "DB connection released" })
        conn.release()
      }
    }

    // ── check_duplicates (read-only CSV-preview helper) ─────────────────────────
    // Mirrors manufacturers/route.ts's action of the same name.
    if (body.action === "check_duplicates") {
      const { rows } = body
      const duplicates: Record<number, string[]> = {}
      // Rows that agree with an existing vendor on at least 2 of
      // {name, registered_name, gst_number} aren't a "duplicate" error —
      // they're treated as an edit of that record (see vendorBulkHandler).
      // This lets any ONE of those three fields (most often the name) change
      // without the row losing its match.
      const editMatches: Record<number, { id: number; code: string; current: EditCandidate }> = {}

      const candidates = await fetchEditMatchCandidates<EditCandidate>({
        selectCandidatesByNames: vendors.selectCandidatesByNamesBatch,
        selectCandidatesByRegisteredNames: vendors.selectCandidatesByRegisteredNamesBatch,
        selectCandidatesByGstNumbers: vendors.selectCandidatesByGstNumbersBatch,
      }, rows)

      rows.forEach((row: Record<string, unknown>, i: number) => {
        const match = findBestEditMatch(row, candidates)
        if (match) editMatches[i] = { id: match.id, code: match.code, current: match }
      })

      const fieldChecks: [string, string, string][] = [
        ["gst_number", vendors.checkDuplicateGstBatch, "GST number"],
        ["ifsc_number", vendors.checkDuplicateIfscBatch, "IFSC code"],
        ["account_number", vendors.checkDuplicateAccountNumberBatch, "Account number"],
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

    // ── update (approval flow) ───────────────────────────────────────────────────
    if (body.action === "update") {
      const { vendor_id, name, type, location, status, zone, registered_name,
              gst_number, bank_name, ifsc_number, account_number, remarks } = body

      const eventId = makeEventId("VENDOR_UPDATE", "update", vendor_id)
      const logCtx = { ...ctx, eventId, module: "VENDOR_UPDATE" }

      const pending = await query(approvalsSql.hasPending, ["VENDOR", vendor_id])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, vendor_id, name, message: "Update blocked due to pending approval" })
        throw new ApiError(
          409,
          "pending_approval",
          "This vendor has a pending approval. Wait for it to be resolved before editing again."
        )
      }
      recordRawEvent("VENDOR_UPDATE", eventId, { code: vendor_id, name: name.trim() })
      logger.info({ ...logCtx, vendor_id, name, message: "Vendor update started." })
      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        type VendorDetailRow = {
          vendor_id: number; location: string | null; status: string; zone: string | null
          registered_name: string | null; code: string; name: string; type: string
          gst_number: string | null; bank_name: string | null; ifsc_number: string | null; account_number: string | null
          gst_certificate_key: string | null; cancelled_cheque_key: string | null; pan_card_key: string | null; misc_document_key: string | null
          [key: string]: unknown
        }
        const [rows] = await conn.execute(vendors.selectById, [vendor_id])
        const current = (rows as VendorDetailRow[])[0]

        if (!current) {
          await conn.rollback()
          logger.warn({ ...logCtx, vendor_id, message: "Vendor not found" })
          throw new ApiError(404, "not_found", "Vendor not found")
        }

        await assertNoDuplicateBankingFields(conn, vendors, { gst_number, ifsc_number, account_number }, Number(vendor_id))

        const proposed: Record<string, string> = {
          name: name.trim(),
          type: type.trim(),
          location: location?.trim() || "",
          zone: zone?.trim() || "",
          registered_name: registered_name?.trim() || "",
          gst_number: gst_number?.trim() || "",
          bank_name: bank_name?.trim() || "",
          ifsc_number: ifsc_number?.trim() || "",
          account_number: account_number?.trim() || "",
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

        const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [userId, "VENDOR", vendor_id, "edit"])
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

        await conn.execute(vendors.setStatus, ["in_review", vendor_id])
        await insertHistoryEntry(conn, {
          module: "VENDOR",
          entityId: Number(vendor_id),
          actionType: "edit",
          remarks: remarks.trim(),
          createdBy: userId,
        })

        await conn.commit()
        logger.info({ ...logCtx, vendor_id, approvalId, message: "Vendor update submitted for approval" })
        recordProcessedEvent("VENDOR_UPDATE", eventId, { vendor_id, approvalId })

        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        await conn.rollback()
        recordFailedEvent("VENDOR_UPDATE", eventId, { code: String(vendor_id), name: name.trim() }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, vendor_id, err: message, stack, message: "Vendor update failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    // ── bulk_from_s3 ─────────────────────────────────────────────────────────────
    // Same staging-only behaviour as "bulk" above — the file is already in S3
    // (client uploaded it via /api/upload), so we just parse it for a preview
    // count and stage ONE approval referencing that key.
    if(body.action === "bulk_from_s3") {
      const { key } = body
      const eventId = makeEventId("VENDOR_BULK", "bulk-s3")
      const logCtx = { ...ctx, eventId, module: "VENDOR_BULK" }

      let rawRows
      try {
        rawRows = await parseS3Import(key)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ ...logCtx, message: "Failed to parse the file" })
        throw new ApiError(400, "parse_error", "Failed to parse file: " + message)
      }

      if (rawRows.length === 0) {
        logger.debug({ ...logCtx, message: "File is empty or has no data rows." })
        throw new ApiError(400, "empty_file", "File is empty or has no data rows")
      }
      logger.info({ ...logCtx, rowCount: rawRows.length, message: "Vendor bulk upload (S3) started." })
      recordRawEvent("VENDOR_BULK", eventId, { source: "s3", s3Key: key, rowCount: rawRows.length })

      const conn = await pool.getConnection()
      let staged = 0
      let skipped = 0
      try {
        const resolved = await resolveVendorBulkRows(conn, rawRows)
        const createRows = resolved.filter((r) => r.action === "create").map((r) => r.row)
        const editEntries = resolved.filter((r) => r.action === "edit")
        skipped = resolved.length - createRows.length - editEntries.length

        if (createRows.length === 0 && editEntries.length === 0) {
          throw new ApiError(400, "nothing_to_stage", `All ${rawRows.length} row${rawRows.length !== 1 ? "s" : ""} were skipped — nothing to submit for approval.`)
        }

        // The originally-uploaded file (`key`) has every row, edits included
        // — VENDOR_BULK's staged file must only ever contain new records
        // (see the "bulk" action above), so re-upload just the create rows
        // rather than reusing `key` as-is.
        const s3 = createRows.length > 0
          ? await uploadRowsAsCsv(createRows, `imports/vendors/${new Date().toISOString().slice(0, 7)}`, "vendor_bulk")
          : null

        await conn.beginTransaction()

        let editsSubmitted = 0
        let firstEditApprovalId: number | null = null
        for (const { row, existing } of editEntries) {
          const approvalId = await submitVendorBulkEdit(conn, row, existing, userId)
          if (approvalId == null) { skipped++; continue }
          editsSubmitted++
          firstEditApprovalId ??= approvalId
        }

        if (createRows.length === 0 && editsSubmitted === 0) {
          throw new ApiError(400, "nothing_to_stage", "Nothing to submit for approval — every row was skipped or had no actual changes.")
        }

        let batchApprovalId: number | null = null
        if (s3) {
          batchApprovalId = await stageBulkUploadApproval(conn, {
            userId, module: "VENDOR_BULK", s3Key: s3.key, filename: s3.filename, rowCount: createRows.length,
          })
        }
        await conn.commit()

        staged = createRows.length + editsSubmitted
        const approvalId = batchApprovalId ?? firstEditApprovalId
        logger.info({ ...logCtx, approvalId, staged, skipped, message: "Vendor bulk upload (S3) staged for approval" })
        recordProcessedEvent("VENDOR_BULK", eventId, { source: "s3", s3Key: key, staged, skipped, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId, staged, skipped, total: rawRows.length })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        await conn.rollback()
        logger.warn({ ...logCtx, staged, skipped, message: "Transaction rolled back" })
        recordFailedEvent("VENDOR_BULK", eventId, { source: "s3", s3Key: key }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, err: message, stack, message: "Vendor bulk upload (S3) failed" })
        throw new ApiError(500, "internal", "Import failed: " + message)
      } finally {
        conn.release()
      }
    }

    // ── update_docs (document approval flow) ────────────────────────────────────
    if (body.action === "update_docs") {
      const { vendor_id, gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key } = body
      const vendorId = Number(vendor_id)

      const eventId = makeEventId("VENDOR_DOCS", "docs", vendorId)
      const logCtx = { ...ctx, eventId, module: "VENDOR_DOCS" }

      const pending = await query(approvalsSql.hasPending, ["VENDOR", vendorId])
      if (pending.length > 0) {
        logger.warn({ ...logCtx, vendorId, message: "Update blocked due to pending approval" })
        throw new ApiError(
          409,
          "pending_approval",
          "This vendor has a pending approval. Wait for it to be resolved before uploading documents."
        )
      }

      recordRawEvent("VENDOR_DOCS", eventId, { vendorId })
      logger.info({ ...logCtx, vendorId, message: "Vendor docs update started." })

      const conn = await pool.getConnection()
      await conn.beginTransaction()
      try {
        type VendorDocsRow = {
          vendor_id: number
          gst_certificate_key: string | null; cancelled_cheque_key: string | null; pan_card_key: string | null; misc_document_key: string | null
          [key: string]: unknown
        }
        const [rows] = await conn.execute(vendors.selectById, [vendorId])
        const current = (rows as VendorDocsRow[])[0]

        if (!current) {
          await conn.rollback()
          logger.warn({ ...logCtx, vendorId, message: "Vendor not found" })
          throw new ApiError(404, "not_found", "Vendor not found")
        }

        const proposed: Record<string, string | null> = {
          gst_certificate_key:  gst_certificate_key  ?? null,
          cancelled_cheque_key: cancelled_cheque_key ?? null,
          pan_card_key:         pan_card_key         ?? null,
          misc_document_key:    misc_document_key    ?? null,
        }
        const diff = Object.entries(proposed).filter(
          ([k, v]) => String(current[k] ?? "") !== String(v ?? "")
        )

        if (diff.length === 0) {
          await conn.rollback()
          return NextResponse.json({ ok: true, message: "No changes detected" })
        }

        const [approvalResult] = await conn.execute(approvalsSql.insertApproval, [userId, "VENDOR", vendorId, "edit"])
        const approvalId = (approvalResult as { insertId: number }).insertId

        for (const [field, newVal] of diff) {
          await conn.execute(approvalsSql.insertApprovalItem, [
            approvalId,
            field,
            String(current[field] ?? ""),
            String(newVal ?? ""),
          ])
        }

        await conn.execute(vendors.setStatus, ["in_review", vendorId])
        await conn.commit()

        logger.info({ ...logCtx, vendorId, approvalId, message: "Vendor documents submitted for approval" })
        recordProcessedEvent("VENDOR_DOCS", eventId, { vendorId, approvalId })
        return NextResponse.json({ ok: true, approval_id: approvalId })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? err.stack : undefined
        await conn.rollback()
        recordFailedEvent("VENDOR_DOCS", eventId, { vendor_id: String(vendorId) }, message)
        if (err instanceof ApiError) throw err
        logger.error({ ...logCtx, vendorId, err: message, stack, message: "Vendor docs update failed" })
        throw new ApiError(500, "internal", "Database error")
      } finally {
        conn.release()
      }
    }

    logger.warn({...ctx , message: "Invalid action"})
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }
})
