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
import { mintCapability, listDocuments, downloadDocument, uploadDocument, DOC_MAX_BYTES, UploadLinkRefused, type DocCapability } from "./document"
import { retryAfter } from "./retry-after"
import { UniwareSessionStale } from "./web-session"
import { getFileBuffer, uploadFile } from "@/lib/s3"
import { monthIST } from "@/lib/date"
import { UNIWARE_SANDBOX, UNIWARE_DOC_FACILITIES } from "@/lib/env"
import { facilityForInvoice } from "./facility-resolve"
import { composeDocBatch } from "./doc-batch"
import logger from "@/lib/logger"

// ponytail: a flat cap like the GRN sweep's. Each invoice is 1 mint + a list +
// a download per new file + maybe one upload; 40 fits comfortably in maxDuration.
export const MAX_PER_RUN = 40

/** Prod facilities the document sync is enabled for, from UNIWARE_DOC_FACILITIES. */
const DOC_FACILITIES = UNIWARE_DOC_FACILITIES.split(",").map((s) => s.trim()).filter(Boolean)
/** `*` means every facility — the "on for all of prod" switch. */
const DOC_ALL = DOC_FACILITIES.includes("*")

/**
 * May the document sync touch this invoice's facility?
 *
 * Off prod the sandbox pins everything to TEST_FACILITY, so everything is in
 * scope. On prod it is driven by UNIWARE_DOC_FACILITIES (SSM):
 *   "*"                      → every facility
 *   "MUM_WAREHOUSE2,…"       → only those codes
 *   "" (unset)               → inert
 * An invoice whose facility can't be resolved is left alone unless "*" is set.
 */
export function docSyncFacilityAllowed(facility: string | undefined): boolean {
  if (UNIWARE_SANDBOX) return true
  if (DOC_ALL) return true
  if (!facility) return false
  return DOC_FACILITIES.includes(facility)
}

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

/** Waits before each retry at save. Every first try on 2026-11-05 was refused on a PO made seconds before. */
export const SAVE_PUSH_RETRY_MS = [5_000, 15_000, 30_000]

/**
 * Push one invoice's PDF to its Uniware PO at save, retrying a refused upload link.
 * Throws UniwareSessionStale on a dead web session; any failure is left to the document sync.
 */
export async function pushInvoicePdfToUniware(
  inv: { id: number; invoice_no: string; uniware_po_code: string },
  pdf: Buffer,
  s3Key: string
): Promise<boolean> {
  const cap = await mintCapability(inv.uniware_po_code)
  return retryAfter(
    (attempt) => {
      if (attempt > 0) logger.info({ module: "PO_INVOICE", invoice_no: inv.invoice_no, attempt, message: "Retrying Uniware document push" })
      return pushInvoicePdf(cap, inv, pdf, s3Key)
    },
    (err) => err instanceof UploadLinkRefused,
    SAVE_PUSH_RETRY_MS,
  )
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

  // On prod with no facilities chosen, the feature is inert — say so plainly.
  if (!UNIWARE_SANDBOX && DOC_FACILITIES.length === 0) return { ...empty, disabled: true }

  // The newest alone would never come back to an older PDF whose upload failed, so those
  // get a share of the run. Only facilities the sync is on for, or they would hold slots forever.
  const unpushed: Candidate[] = []
  for (const inv of await query<Candidate>(uniwareDocsSql.selectUnpushedCandidates, [])) {
    const facility = !UNIWARE_SANDBOX && !DOC_ALL ? await facilityForInvoice(inv) : undefined
    if (docSyncFacilityAllowed(facility)) unpushed.push(inv)
  }
  const newest = await query<Candidate>(uniwareDocsSql.selectSyncCandidates, [limit + 1])
  const { batch, truncated } = composeDocBatch(unpushed, newest, limit)

  let pulled = 0
  let pushed = 0
  let skipped = 0
  let sessionStale = false
  const failures: { code: string; error: string }[] = []

  for (const inv of batch) {
    try {
      // Only the facilities the feature is enabled for. When everything is in
      // scope (sandbox, or "*") the per-invoice facility lookup is pointless, so
      // it's skipped; a specific allowlist resolves and checks each one.
      const needFacility = !UNIWARE_SANDBOX && !DOC_ALL
      const facility = needFacility ? await facilityForInvoice(inv) : undefined
      if (!docSyncFacilityAllowed(facility)) { skipped++; continue }

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
