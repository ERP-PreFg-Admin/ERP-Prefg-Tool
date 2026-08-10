/**
 * Bulk-upload staging — turns a whole CSV/Excel batch into ONE pending
 * approval instead of inserting rows immediately. The module's
 * ModuleHandler.applyAndArchive (lib/approvals/module-handlers.ts) does the
 * real insert once an admin approves — see the *_BULK handlers there.
 *
 * Shared by vendors/manufacturers/raw-materials/packing-materials bulk
 * import routes.
 */
import type { PoolConnection } from "mysql2/promise"
import { approvalsSql } from "@/lib/queries/approvals"
import { uploadFile } from "@/lib/s3"

/**
 * Minimal CSV serializer for internal round-tripping through
 * lib/import-s3.ts's parseCsvBuffer — NOT for human/Excel export (see
 * lib/export.ts's buildCsv for that, which prepends a Recipe that
 * parseCsvBuffer doesn't strip, corrupting the first header on re-parse).
 */
export function rowsToCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return ""
  const headers = Object.keys(rows[0])
  const escape = (v: string) =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h] ?? "")).join(",")),
  ]
  return lines.join("\r\n")
}

/** Converts client-parsed rows to CSV and uploads them to S3, mirroring the
 *  key/filename shape the client already produces for the `.xlsx` upload path. */
export async function uploadRowsAsCsv(
  rows: Record<string, string>[],
  folder: string,
  filenamePrefix: string,
): Promise<{ key: string; filename: string }> {
  const csv = rowsToCsv(rows)
  const filename = `${filenamePrefix}_${Date.now()}.csv`
  const key = `${folder}/${filename}`
  await uploadFile(Buffer.from(csv, "utf-8"), key, "text/csv")
  return { key, filename }
}

/**
 * Inserts ONE `approvals` row + `s3_key`/`filename`/`row_count`
 * `approval_items`, mirroring the PO_BULK convention (entity_id = uploader's
 * user id, since no real entity exists until the batch is approved).
 */
export async function stageBulkUploadApproval(
  conn: PoolConnection,
  params: { userId: number; module: string; s3Key: string; filename: string; rowCount: number },
): Promise<number> {
  const { userId, module, s3Key, filename, rowCount } = params
  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, module, userId, "create"])
  const approvalId = (ar as { insertId: number }).insertId
  await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "s3_key", "", s3Key])
  await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "filename", "", filename])
  await conn.execute(approvalsSql.insertApprovalItem, [approvalId, "row_count", "", String(rowCount)])
  return approvalId
}
