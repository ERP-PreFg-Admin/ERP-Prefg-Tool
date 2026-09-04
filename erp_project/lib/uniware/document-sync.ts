/**
 * Move documents between our invoices and the Uniware POs they were mirrored to,
 * in both directions, for every mirrored invoice.
 *
 *   PULL  every file attached on the Uniware PO that we don't already hold →
 *         download → our S3 → attachments_invoice (source 'uniware')
 *   PUSH  our supplier-invoice PDF, if it isn't up there yet →
 *         upload to the Uniware PO → attachments_invoice (source 'erp')
 *
 * ── SCOPED TO TEST_FACILITY FOR NOW ──────────────────────────────────────────
 * Gated on UNIWARE_SANDBOX (APP_ENV !== "prod"). On dev every mirrored PO is a
 * TEST_FACILITY sandbox PO, so this only ever touches test-facility documents and
 * nothing in real operations changes. Going live later is this one predicate,
 * nothing else. The document API itself is facility-independent — mint is keyed by
 * PO identifier, not a Facility header — so there is no per-call facility to pin.
 *
 * ── WHY 'source' STOPS A FEEDBACK LOOP ───────────────────────────────────────
 * Once we PUSH our invoice PDF, Uniware lists it, so the next PULL sees it. We
 * record the push as attachments_invoice(source='erp') under the SAME filename we
 * uploaded, and PULL skips any filename already held — so we never download our
 * own upload back. Filename is the dedupe key because Uniware addresses documents
 * by &filename=, so a name is unique within one PO by construction.
 *
 * ── NEVER THROW FOR ONE INVOICE ──────────────────────────────────────────────
 * Same contract as runGrnSync: one PO that fails must not cost the others their
 * answers. The one exception is a dead session — UniwareSessionStale aborts the
 * whole run, because every remaining invoice would fail the same way and the fix
 * is a human re-login, not a retry.
 */

import crypto from "node:crypto"
import { query, execute } from "@/lib/db"
import { uniwareDocsSql } from "@/lib/queries/uniware-documents"
import { mintCapability, listDocuments, downloadDocument, uploadDocument, DOC_MAX_BYTES, type DocCapability } from "./document"
import { UniwareSessionStale } from "./web-session"
import { getFileBuffer, uploadFile } from "@/lib/s3"
import { monthIST } from "@/lib/date"
import { UNIWARE_SANDBOX } from "@/lib/env"
import logger from "@/lib/logger"

// ponytail: a flat cap like the GRN sweep's. Each invoice is 1 mint + a list +
// a download per new file + maybe one upload; 40 fits comfortably in maxDuration.
export const MAX_PER_RUN = 40

type Candidate = {
  id: number
  invoice_no: string
  mfg_id: number
  destination: string | null
  buyer_gstin: string | null
  uniware_po_code: string
  attachment_key: string | null
}

export type DocSyncResult = {
  total: number
  pulled: number
  pushed: number
  /** Invoices asked about that had nothing new either way. */
  skipped: number
  failed: number
  failures: { code: string; error: string }[]
  /** The session died mid-run; the rest was not attempted. */
  sessionStale: boolean
  truncated: boolean
  limit: number
  /** Off dev the whole feature is inert, by design. */
  disabled?: boolean
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

/** A stable, filesystem-safe name for the invoice PDF we push. Stable so a
 *  re-run recognises it as already pushed rather than uploading a duplicate. */
function pushFilename(invoiceNo: string): string {
  const safe = invoiceNo.replace(/[^a-zA-Z0-9._-]/g, "-")
  return `Invoice ${safe}.pdf`
}

/**
 * Upload the supplier-invoice PDF onto its Uniware PO and record it, once.
 * Returns true if uploaded, false if skipped (already held, or over the ceiling).
 * The single push implementation, shared by the sweep and the inline commit path.
 *
 * s3_key reuses the existing invoice PDF object rather than making a second copy,
 * and the recorded filename is the SAME one uploaded, so a later PULL skips it.
 */
async function pushInvoicePdf(
  cap: DocCapability,
  inv: { id: number; invoice_no: string },
  pdf: Buffer,
  s3Key: string,
  heldNames?: Set<string>
): Promise<boolean> {
  const name = pushFilename(inv.invoice_no)
  if (heldNames?.has(name)) return false
  // Over Uniware's ceiling: leave it for a human rather than failing the caller.
  if (pdf.length > DOC_MAX_BYTES) return false
  // uploadDocument is idempotent — false means it was already on the PO. Record
  // it either way (INSERT IGNORE dedups), so our side knows the file is there.
  const uploaded = await uploadDocument(cap, name, pdf, "application/pdf")
  await execute(uniwareDocsSql.insertAttachment, [
    inv.id, name, s3Key, "application/pdf", pdf.length, "erp", null, null, null,
  ])
  return uploaded
}

/**
 * Push one invoice's PDF to its Uniware PO, minting its own capability — the
 * entry point for the inline invoice-commit path, which already holds the PDF
 * bytes. Throws UniwareSessionStale if the web session is dead; the caller treats
 * that as a non-fatal skip, since the Sync Documents button will retry it.
 */
export async function pushInvoicePdfToUniware(
  inv: { id: number; invoice_no: string; uniware_po_code: string },
  pdf: Buffer,
  s3Key: string
): Promise<boolean> {
  const cap = await mintCapability(inv.uniware_po_code)
  return pushInvoicePdf(cap, inv, pdf, s3Key)
}

/**
 * One invoice, both directions. Throws on failure (the caller has a per-invoice
 * catch); a dead session surfaces as UniwareSessionStale, which the caller treats
 * as fatal to the whole run.
 */
export async function syncDocumentsForInvoice(inv: Candidate): Promise<{ pulled: number; pushed: number }> {
  const cap = await mintCapability(inv.uniware_po_code)

  const held = await query<{ filename: string; source: string }>(uniwareDocsSql.selectFilenames, [inv.id])
  const heldNames = new Set(held.map((h) => h.filename))

  // ── PULL ──────────────────────────────────────────────────────────────────
  let pulled = 0
  for (const doc of await listDocuments(cap)) {
    if (heldNames.has(doc.fileName)) continue
    const buf = await downloadDocument(cap, doc.fileName)
    const ct = contentTypeFor(doc.fileName)
    const safe = doc.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
    const key = `uniware-docs/${monthIST()}/${inv.id}-${crypto.randomUUID().slice(0, 8)}-${safe}`
    await uploadFile(buf, key, ct)
    await execute(uniwareDocsSql.insertAttachment, [
      inv.id, doc.fileName, key, ct, buf.length, "uniware",
      doc.documentLocation, doc.uploadedBy, doc.created,
    ])
    heldNames.add(doc.fileName)
    pulled++
  }

  // ── PUSH ──────────────────────────────────────────────────────────────────
  // Only the supplier invoice PDF, and only once (pushInvoicePdf dedups by name).
  let pushed = 0
  if (inv.attachment_key) {
    const buf = await getFileBuffer(inv.attachment_key)
    if (await pushInvoicePdf(cap, inv, buf, inv.attachment_key, heldNames)) pushed++
  }

  return { pulled, pushed }
}

export async function runDocumentSync(
  ctx: Record<string, unknown> = {},
  limit = MAX_PER_RUN
): Promise<DocSyncResult> {
  const empty: DocSyncResult = {
    total: 0, pulled: 0, pushed: 0, skipped: 0, failed: 0,
    failures: [], sessionStale: false, truncated: false, limit,
  }

  // Scoped to the test facility for now — see the header. Inert, not an error.
  if (!UNIWARE_SANDBOX) return { ...empty, disabled: true }

  const rows = await query<Candidate>(uniwareDocsSql.selectSyncCandidates, [limit + 1])
  const truncated = rows.length > limit
  const batch = truncated ? rows.slice(0, limit) : rows

  let pulled = 0
  let pushed = 0
  let skipped = 0
  let sessionStale = false
  const failures: { code: string; error: string }[] = []

  for (const inv of batch) {
    try {
      const one = await syncDocumentsForInvoice(inv)
      pulled += one.pulled
      pushed += one.pushed
      if (one.pulled === 0 && one.pushed === 0) skipped++
    } catch (err) {
      // A dead session fails every remaining invoice identically; stop and say so
      // rather than logging forty copies of the same thing.
      if (err instanceof UniwareSessionStale) { sessionStale = true; break }
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ code: inv.uniware_po_code, error })
      logger.warn({ ...ctx, poCode: inv.uniware_po_code, err: error, message: "Uniware document sync failed for one invoice" })
    }
  }

  return {
    total: batch.length,
    pulled, pushed, skipped,
    failed: failures.length,
    failures: failures.slice(0, 10),
    sessionStale, truncated, limit,
  }
}
