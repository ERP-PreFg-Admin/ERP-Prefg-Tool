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
    SELECT id, entity_type, entity_code, legal_entity_code, email,
           recipient_type, purpose, created_at
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

  /** Params: [entity_type, entity_code, legal_entity_code, email, recipient_type, purpose].
   *  legal_entity_code is NULL for vendor/mfg/employee and for a warehouse
   *  address that serves every entity. */
  insert: `
    INSERT INTO entity_emails (entity_type, entity_code, legal_entity_code, email, recipient_type, purpose)
    VALUES (?, ?, ?, ?, ?, ?)
  `,

  /** All emails on file for one entity. Ignores legal_entity_code — correct for
   *  vendor, which never sets it. Manufacturers use selectForMfg (employees and
   *  the '*' wildcard); warehouses use selectByWarehouseForEntity, or an
   *  entity's POC is mailed another entity's paperwork.
   *  Params: [entity_type, entity_code] */
  selectByEntity: `
    SELECT email, recipient_type FROM entity_emails
    WHERE entity_type = ? AND entity_code = ?
  `,

  /**
   * A manufacturer's recipients: its own contacts, plus internal employees
   * attached to it, plus employees attached to EVERY manufacturer.
   *
   * '*' is the wildcard an "all manufacturers" employee row is stored under, so
   * a manufacturer added next month is covered without anyone revisiting this
   * list. It is matched only inside the employee arm — no other type writes it.
   * Params: [mfg_code, mfg_code]
   */
  selectForMfg: `
    SELECT email, recipient_type FROM entity_emails
    WHERE (entity_type = 'mfg'      AND entity_code = ?)
       OR (entity_type = 'employee' AND (entity_code = ? OR entity_code = '*'))
  `,

  /**
   * A warehouse's recipients for one legal entity: the shared addresses plus that
   * entity's own. The UNION is deliberate — a general warehouse inbox keeps
   * receiving everything and the entity's POC is added on top, rather than the
   * POC silently replacing it.
   *
   * Pass null for legalEntityCode and only the shared rows come back, which is
   * what happens when the entity can't be resolved from an invoice.
   *
   * Employees attached to this site come along: they never carry a
   * legal_entity_code, so the NULL arm already includes them for every entity.
   * Params: [entity_code, legal_entity_code]
   */
  selectByWarehouseForEntity: `
    SELECT email, recipient_type FROM entity_emails
    WHERE entity_type IN ('warehouse', 'employee')
      AND entity_code = ?
      AND (legal_entity_code IS NULL OR legal_entity_code = ?)
  `,

  /** The legal entities, for the entity-email form's selector. */
  legalEntityOptions: `
    SELECT code, legal_name FROM master_entity WHERE status = 'active' ORDER BY code ASC
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

  /** Guards for entity_code, which carries no FK. Params: [code] */
  warehouseExistsByName:  `SELECT id FROM master_warehouse WHERE name = ? LIMIT 1`,
  mfgExistsByCode:        `SELECT id FROM master_mfgs      WHERE code = ? LIMIT 1`,
}
