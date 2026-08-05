/**
 * Entity Emails Queries
 *
 * Lightweight contact list mapping a vendor/manufacturer code — or a warehouse
 * name — to an email address for a given purpose (e.g. "PO", "invoice",
 * "quality"). Independent of details_vendor/details_mfg — not part of the
 * approval workflow.
 */

export const entityEmails = {
  /**
   * Paginated list with optional entity_type filter + search across
   * code/email/purpose. Params: [type, type, like, like, like, like, LIMIT, OFFSET]
   */
  selectPaginated: `
    SELECT id, entity_type, entity_code, email, purpose, created_at
    FROM entity_emails
    WHERE (? IS NULL OR entity_type = ?)
      AND (? IS NULL OR entity_code LIKE ? OR email LIKE ? OR purpose LIKE ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `,

  /** Params: [type, type, like, like, like, like] */
  countPaginated: `
    SELECT COUNT(*) AS total
    FROM entity_emails
    WHERE (? IS NULL OR entity_type = ?)
      AND (? IS NULL OR entity_code LIKE ? OR email LIKE ? OR purpose LIKE ?)
  `,

  insert: `
    INSERT INTO entity_emails (entity_type, entity_code, email, purpose)
    VALUES (?, ?, ?, ?)
  `,

  /** All emails on file for one entity (e.g. a manufacturer's PO recipients). Params: [entity_type, entity_code] */
  selectByEntity: `
    SELECT email FROM entity_emails
    WHERE entity_type = ? AND entity_code = ?
  `,

  /** Lightweight code/name list for the "vendor" entity type dropdown. */
  vendorOptions: `SELECT id, code, name FROM master_vendors ORDER BY code ASC`,

  /** Lightweight code/name list for the "mfg" entity type dropdown. */
  mfgOptions: `SELECT id, code, name FROM master_mfgs ORDER BY code ASC`,

  /**
   * Same shape for the "warehouse" dropdown. A warehouse has no code — its
   * name is the key, because that is what purchase_orders.destination stores
   * and what the inward-invoice mail looks recipients up by.
   */
  warehouseOptions: `
    SELECT id, name AS code, location AS name
    FROM master_warehouse
    ORDER BY name ASC
  `,
}
