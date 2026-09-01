/**
 * attachments_invoice + uniware_web_session — see prisma/add_uniware_documents.sql
 * for why these tables exist and what `source` protects.
 */

export const uniwareDocsSql = {
  /** The current tenant web cookie. One row matters; older ones are history. */
  selectSession: `
    SELECT cookie, obtained_at, expires_at, obtained_by
      FROM uniware_web_session
     ORDER BY id DESC
     LIMIT 1`,

  insertSession: `
    INSERT INTO uniware_web_session (cookie, expires_at, obtained_by)
    VALUES (?, ?, ?)`,

  /** Keep the table from growing a row per login, forever. */
  pruneSessions: `
    DELETE FROM uniware_web_session
     WHERE id NOT IN (SELECT id FROM (
             SELECT id FROM uniware_web_session ORDER BY id DESC LIMIT 5
           ) keep)`,

  /**
   * INSERT IGNORE, not INSERT: uq_invoice_filename is what makes the pull
   * idempotent. The sweep inserts every document Uniware lists and lets the
   * index reject the ones already held, rather than reading first and racing.
   */
  insertAttachment: `
    INSERT IGNORE INTO attachments_invoice
      (invoice_id, filename, s3_key, content_type, bytes, source,
       uniware_doc_id, uniware_uploaded_by, uniware_created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  /** What we already hold for one invoice — the pull's skip list. */
  selectFilenames: `
    SELECT filename, source FROM attachments_invoice WHERE invoice_id = ?`,

  selectByInvoice: `
    SELECT id, invoice_id, filename, s3_key, content_type, bytes, source,
           uniware_uploaded_by, uniware_created, synced_at
      FROM attachments_invoice
     WHERE invoice_id = ?
     ORDER BY id`,

  /** Every attachment for a set of invoices, for the list screen's expansion. */
  buildSelectByInvoices: (n: number) => `
    SELECT id, invoice_id, filename, s3_key, content_type, bytes, source,
           uniware_uploaded_by, uniware_created, synced_at
      FROM attachments_invoice
     WHERE invoice_id IN (${Array(n).fill("?").join(",")})
     ORDER BY invoice_id, id`,

  /**
   * Invoices the sweep can act on: mirrored to Uniware at all.
   *
   * No "and not yet synced" predicate — a PO gains documents days after it is
   * raised, so the only way to know is to ask. The caller caps the set.
   */
  selectSyncCandidates: `
    SELECT id, invoice_no, mfg_id, destination, buyer_gstin,
           uniware_po_code, attachment_key
      FROM invoice_mfg
     WHERE uniware_po_code IS NOT NULL AND uniware_po_code <> ''
     ORDER BY id DESC
     LIMIT ?`,

  selectSyncCandidateById: `
    SELECT id, invoice_no, mfg_id, destination, buyer_gstin,
           uniware_po_code, attachment_key
      FROM invoice_mfg
     WHERE id = ?`,
}
