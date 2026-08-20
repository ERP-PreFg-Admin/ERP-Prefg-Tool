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
    SELECT ee.id, ee.entity_type, ee.entity_code, ee.legal_entity_code, ee.email,
           ee.recipient_type, ee.purpose, ee.status, ee.created_at,
           ee.created_by, u.name AS created_by_name
    FROM entity_emails ee
    LEFT JOIN users u ON u.id = ee.created_by
    WHERE (? IS NULL OR ee.entity_type = ?)
      AND (? IS NULL OR ee.entity_code LIKE ? OR ee.email LIKE ? OR ee.purpose LIKE ?)
    ORDER BY ee.id DESC
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
    INSERT INTO entity_emails
      (entity_type, entity_code, legal_entity_code, email, recipient_type, purpose, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** All emails on file for one entity. Ignores legal_entity_code — correct for
   *  vendor, which never sets it. Manufacturers use selectForMfg (employees and
   *  the '*' wildcard); warehouses use selectByWarehouseForEntity, or an
   *  entity's POC is mailed another entity's paperwork.
   *  Params: [entity_type, entity_code] */
  selectByEntity: `
    SELECT email, recipient_type FROM entity_emails
    WHERE entity_type = ? AND entity_code = ?
      AND status = 'active'
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
    WHERE status = 'active'
      AND ((entity_type = 'mfg'      AND entity_code = ?)
        OR (entity_type = 'employee' AND (entity_code = ? OR entity_code = '*')))
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
   *
   * entity_code = '*' on a WAREHOUSE row is the "every warehouse" wildcard — the
   * counterpart of the manufacturer one in selectForMfg, so a site added next
   * month is covered without revisiting this list. Restricted to the warehouse
   * arm on purpose: an employee's '*' already means every MANUFACTURER, and
   * letting one value mean both here would silently copy every mfg-wide employee
   * onto every warehouse's mail.
   *
   * A wildcard row may still carry a legal_entity_code, so "every warehouse, Pep
   * only" is expressible — the entity filter below applies to it unchanged.
   * Params: [entity_code, legal_entity_code]
   */
  selectByWarehouseForEntity: `
    SELECT email, recipient_type FROM entity_emails
    WHERE status = 'active'
      AND entity_type IN ('warehouse', 'employee')
      AND (entity_code = ? OR (entity_type = 'warehouse' AND entity_code = '*'))
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

  /** One row, for the edit dialog to load and for the update to check it exists.
   *  Params: [id] */
  selectById: `
    SELECT id, entity_type, entity_code, legal_entity_code, email, recipient_type,
           purpose, status, created_by, created_at
    FROM entity_emails WHERE id = ? LIMIT 1
  `,

  /**
   * Is this address already on file for the same entity? Backs the friendly
   * message; uq_entity_email is what actually enforces it, so two concurrent
   * submits cannot both pass.
   *
   * COALESCE on both sides so "every entity" (NULL) compares equal to itself —
   * `NULL = NULL` is unknown in SQL, so a raw comparison would report no
   * duplicate for the commonest case and let the insert fail on the constraint
   * with a raw ER_DUP_ENTRY instead.
   *
   * The trailing id is the row to EXCLUDE, so an edit that leaves the address
   * unchanged doesn't collide with itself. Pass 0 when inserting.
   * Params: [entity_type, entity_code, legal_entity_code, email, id]
   */
  findDuplicate: `
    SELECT id FROM entity_emails
    WHERE entity_type = ?
      AND entity_code = ?
      AND COALESCE(legal_entity_code, '') = COALESCE(?, '')
      AND email = ?
      AND id <> ?
    LIMIT 1
  `,

  /**
   * created_by/created_at are deliberately NOT updated — they record who first
   * added the contact, which an edit does not change.
   * Params: [entity_type, entity_code, legal_entity_code, email, recipient_type,
   *          purpose, status, id]
   */
  updateById: `
    UPDATE entity_emails
       SET entity_type = ?, entity_code = ?, legal_entity_code = ?,
           email = ?, recipient_type = ?, purpose = ?, status = ?
     WHERE id = ?
  `,
}
