/**
 * S3 File Attachment Queries
 *
 * All SQL related to storing and retrieving S3 object keys against
 * various entities in the ERP. Keys are stored as TEXT NULL columns;
 * signed URLs are generated on demand via lib/s3.ts.
 */

/**
 * Every place an object key is stored, one SELECT per table.
 *
 * Read by lib/s3-guard.ts to answer "does this key belong to a row the caller is
 * allowed to see". A key that appears in none of them is not readable at all —
 * that is what stops a signed-in user presigning arbitrary objects out of the
 * bucket (docs/qa-audit-2026-08.md #5).
 *
 * Each branch returns the scope dimensions of the owning row: `mfg_id` and
 * `destination` where the owner has them, NULL where it doesn't. NULL means "not
 * scoped by that dimension" and passes — masters and the approvals queue are
 * deliberately unscoped (see lib/scope.ts), so their documents have to be too,
 * or a document would be unopenable on a list page that shows its row.
 *
 * Every `?` binds the same key, so the parameter count is derived from the SQL
 * below rather than maintained alongside it — see KEY_OWNER_PARAM_COUNT.
 */
const KEY_OWNER_SELECTS = [
  // PO attachment and the bulk CSV a PO was imported from.
  `SELECT mfg_id, destination FROM purchase_orders
     WHERE attachment_key = ? OR csv_source_key = ?`,

  // Supplier invoice PDF.
  `SELECT mfg_id, NULL AS destination FROM invoice_mfg
     WHERE attachment_key = ?`,

  // Uniware PO documents pulled into our S3 (attachments_invoice), scoped like
  // the invoice PDF they sit beside — by the owning invoice's manufacturer.
  `SELECT im.mfg_id, NULL AS destination FROM attachments_invoice ai
     JOIN invoice_mfg im ON im.id = ai.invoice_id
    WHERE ai.s3_key = ?`,

  // A PO attachment that has since been replaced still has readable history.
  `SELECT po.mfg_id, po.destination FROM history_pos h
     JOIN purchase_orders po ON po.id = h.po_id
    WHERE h.s3_key = ?`,

  // Vendor / manufacturer statutory documents (unscoped, as above).
  `SELECT NULL, NULL FROM details_vendor
     WHERE gst_certificate_key = ? OR cancelled_cheque_key = ?
        OR pan_card_key = ? OR misc_document_key = ?`,
  `SELECT NULL, NULL FROM details_mfg
     WHERE gst_certificate_key = ? OR cancelled_cheque_key = ?
        OR pan_card_key = ? OR misc_document_key = ?`,

  // Recipe artifacts.
  `SELECT NULL, NULL FROM artifacts_recipe WHERE s3_key = ?`,

  // Anything staged in a pending approval: bulk-upload CSVs (field_name
  // 's3_key'), document changes awaiting review, Recipe artifact adds. Matching on
  // the value rather than the field name covers all three shapes.
  `SELECT NULL, NULL FROM approval_items WHERE new_value = ? OR old_value = ?`,
]

export const s3FilesSql = {
  // ── Purchase Orders ──────────────────────────────────────────────────────

  /** Set or clear the attachment on a PO. Parameters: [attachment_key | null, po_id] */
  updatePoAttachment: `
    UPDATE purchase_orders SET attachment_key = ? WHERE id = ?
  `,

  /** Fetch the current attachment key for a PO. Parameters: [po_id] */
  getPoAttachment: `
    SELECT attachment_key FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /**
   * Claim the attachment slot for a generated PO document, but only if nothing
   * holds it yet. Parameters: [attachment_key, po_id]
   *
   * The `IS NULL` guard is the whole correctness argument for re-sending the same
   * document. Without it, a second send would overwrite the key and the
   * manufacturer's copy would stop matching ours — and two concurrent sends could
   * each upload a different render and race to claim the row.
   *
   * It also protects the other meaning this column carries: an inward PO's
   * attachment_key points at the supplier invoice it came from (see
   * lib/invoice/invoice-inward.ts). Guarding on NULL means the mail path can never
   * replace that.
   *
   * affectedRows tells the caller which happened: 1 = we claimed it, 0 = someone
   * else already had it and their document is the one to send.
   */
  setPoAttachmentIfAbsent: `
    UPDATE purchase_orders SET attachment_key = ?
     WHERE id = ? AND attachment_key IS NULL
  `,

  // ── Key authorization ────────────────────────────────────────────────────

  /**
   * Rows that own a given S3 key, with their scope dimensions.
   * Parameters: the same key, KEY_OWNER_PARAM_COUNT times.
   */
  selectKeyOwners: KEY_OWNER_SELECTS.join("\n    UNION ALL\n    "),
}

/** How many times `selectKeyOwners` wants the key. Counted, not hand-written. */
export const KEY_OWNER_PARAM_COUNT = (s3FilesSql.selectKeyOwners.match(/\?/g) ?? []).length
