/**
 * Warehouse Queries
 * Centralized queries for master_warehouse, master_entity and
 * details_warehouse_entity.
 *
 * Note the shape of this domain: master_warehouse is one row per physical
 * LOCATION, and details_warehouse_entity carries one row per (location, legal
 * entity) with that entity's own Unicommerce facility code, GST registration and
 * bill-to/ship-to addresses. Every location operates under BOTH Pep and Kreative
 * with a different facility, which is the dimension master_warehouse never had.
 *
 *   master_warehouse(id, name, location, zone, state, type, status, created_by,
 *     created_at, updated_at)
 *   master_entity(id, code, legal_name, pan, status, created_at)
 *   details_warehouse_entity(id, warehouse_id → master_warehouse.id,
 *     entity_id → master_entity.id, facility_code, gstin, bill_to_name,
 *     bill_to_address, ship_to_name, ship_to_address, status, created_at,
 *     updated_at)
 *
 * `name` is a de-facto foreign key with nothing enforcing it: purchase_orders
 * .destination, invoice_mfg.destination and entity_emails.entity_code are
 * unindexed VARCHAR copies of it, and lib/scope.ts resolves warehouse scope to
 * names rather than ids. It is therefore immutable after create — nothing here
 * puts it in a SET list. See prisma/backfill_warehouse_data.sql for what a
 * rename would have orphaned.
 *
 * `location` holds the CITY and `state` the state. It used to hold the state,
 * and it is what the PO destination dropdown renders (see warehouseOptions in
 * lib/queries/purchase-orders.ts) — so it is user-visible.
 */

/** Every column the list, the dialogs and the approval diff read.
 *
 *  Hoisted because selectAll and selectById must not drift: selectById is what
 *  the approval diff compares against, so a column missing there reads back
 *  undefined and the field silently looks "unchanged". query<T> is an unchecked
 *  cast, so that mistake compiles, type-checks and lints. */
const WAREHOUSE_COLUMNS = `
  w.id, w.code, w.name, w.location, w.state, w.zone, w.type,
  w.contact_person, w.contact_phone, w.site_gstin,
  w.status, w.created_by, w.created_at, w.updated_at
`

export const warehouse = {
  // ============ SELECT QUERIES ============

  /**
   * Full list for /masters/warehouses. Ten-ish rows, so no pagination and no
   * scope predicate — warehouses are unscoped, matching Vendors/Manufacturers.
   *
   * ORDER BY type DESC puts MWH (mother warehouses) before CWH, matching the PO
   * destination dropdown at purchase-orders.ts warehouseOptions.
   */
  selectAll: `
    SELECT ${WAREHOUSE_COLUMNS}
    FROM master_warehouse w
    ORDER BY w.type DESC, w.name ASC
  `,

  /**
   * The per-entity rows for one or more warehouses, entity code and name joined
   * in for display. Kept separate from selectAll rather than aggregated into it:
   * two rows per location would either need GROUP_CONCAT (unparseable once
   * addresses are in play) or duplicate every location row.
   *
   * Pass an empty array and you get nothing — callers should skip the query.
   * Parameters: [warehouseIds] — needs query(), not execute(), for IN (?)
   * array expansion.
   */
  selectEntityRowsByWarehouseIds: `
    SELECT
      dwe.id, dwe.warehouse_id, dwe.entity_id,
      e.code AS entity_code, e.legal_name AS entity_name,
      dwe.facility_code, dwe.type,
      dwe.bill_to_gstin, dwe.bill_to_name, dwe.bill_to_address,
      dwe.ship_to_gstin, dwe.ship_to_name, dwe.ship_to_address,
      dwe.ship_to_line1, dwe.ship_to_line2, dwe.ship_to_city,
      dwe.ship_to_state, dwe.ship_to_pincode,
      dwe.status, dwe.remarks, dwe.created_at, dwe.updated_at
    FROM details_warehouse_entity dwe
    JOIN master_entity e ON e.id = dwe.entity_id
    WHERE dwe.warehouse_id IN (?)
    ORDER BY dwe.warehouse_id, e.code
  `,

  /** The legal entities, for the Add/Edit dialog dropdown. Its own entry rather
   *  than a lib/queries/entities.ts — one string, read by one page. */
  entityOptions: `
    SELECT id, code, legal_name, pan
    FROM master_entity
    WHERE status = 'active'
    ORDER BY code ASC
  `,

  /**
   * The Uniware facility for a destination and the entity that was billed.
   *
   * `destination` is master_warehouse.name — purchase_orders.destination and
   * invoice_mfg.destination are unindexed VARCHAR copies of it with no FK, so
   * the name is the key.
   *
   * Matched on PAN, NOT on the full GSTIN. Kreative bills to its Mumbai
   * registration while shipping to Guwahati, Kolkata and the rest, so comparing
   * GSTINs or their state prefixes would reject almost every legitimate invoice.
   * panOf() in lib/invoice/gstin.ts is the entity identity for exactly this reason.
   *
   * Returns the entity's `code` too, because the caller needs it for warehouse
   * mail routing (entity_emails.legal_entity_code) — one query rather than two,
   * and it cannot drift from the facility it was resolved alongside.
   *
   * `wh_id` (details_warehouse_entity.id) rides along for the same reason: it is
   * the key un_code_mfg_sku_wh_map is scoped by, and the inward push needs this
   * facility's Uniware VENDOR code for the manufacturer right after resolving
   * the facility itself. Resolving the pair twice is how the two would disagree.
   *
   * Parameters: [destination, pan]
   */
  facilityByDestinationAndPan: `
    SELECT dwe.id AS wh_id, dwe.facility_code, e.code AS entity_code
    FROM master_warehouse w
    JOIN details_warehouse_entity dwe ON dwe.warehouse_id = w.id AND dwe.status = 'active'
    JOIN master_entity e ON e.id = dwe.entity_id
    WHERE w.name = ? AND e.pan = ?
    LIMIT 1
  `,

  /** Pre-check before insert, so a duplicate returns a readable 409 instead of
   *  ER_DUP_ENTRY on uq_warehouse_name. Case-insensitive by collation
   *  (utf8mb4_0900_ai_ci), which is what the UNIQUE index enforces too — so the
   *  check and the index agree.
   *  Parameters: [name] */
  selectByNameForDup: `SELECT id FROM master_warehouse WHERE name = ? LIMIT 1`,

  /**
   * One facility's ERP PO-code config, with the columns a scope check needs.
   *
   * `wh_name` is not decoration: facility ids arrive from the client as small
   * consecutive integers, and lib/scope.ts's warehouse dimension is NAMES
   * (purchase_orders.destination stores the name), so the id has to be resolved to
   * a name before it can be checked at all. Same reason
   * mfgFacilityMap.selectFacilityById returns it.
   *
   * Not filtered on status: an inactive facility must still be readable so its
   * config can be corrected, and the write path checks scope rather than status.
   *
   * Parameters: [facility_id]
   */
  selectPoConfigById: `
    SELECT dwe.id, dwe.facility_code, dwe.po_short_code, dwe.po_seq_seed,
           w.name AS wh_name, e.code AS entity_code
    FROM details_warehouse_entity dwe
    INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
    INNER JOIN master_entity    e ON e.id = dwe.entity_id
    WHERE dwe.id = ?
    LIMIT 1
  `,

  /**
   * Every active facility's ERP PO-code config, for the review screen.
   *
   * Unpaginated on purpose — 18 rows, the same shape of call the mfg-overview
   * matrix already makes over this table. Ordered entity then location so the two
   * rows of one site sit in predictable places.
   */
  selectPoConfigs: `
    SELECT dwe.id, dwe.facility_code, dwe.po_short_code, dwe.po_seq_seed,
           w.name AS wh_name, w.location, e.code AS entity_code
    FROM details_warehouse_entity dwe
    INNER JOIN master_warehouse w ON w.id = dwe.warehouse_id
    INNER JOIN master_entity    e ON e.id = dwe.entity_id
    WHERE dwe.status = 'active'
    ORDER BY e.code, w.name
  `,

  // ============ INSERT QUERIES ============

  /** Parameters: [code, name, location, state, zone, type, contact_person,
   *  contact_phone, site_gstin, status, created_by] */
  insert: `
    INSERT INTO master_warehouse
      (code, name, location, state, zone, type,
       contact_person, contact_phone, site_gstin, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Upsert one location's row for one entity. Matches on uq_warehouse_entity, so
   * re-submitting an entity's details edits the existing row rather than
   * erroring — which is what the Edit dialog does on every save.
   * Parameters: [warehouse_id, entity_id, facility_code, type, bill_to_gstin,
   *   bill_to_name, bill_to_address, ship_to_gstin, ship_to_name, ship_to_line1,
   *   ship_to_line2, ship_to_city, ship_to_state, ship_to_pincode,
   *   ship_to_address, status, remarks]
   */
  upsertEntityRow: `
    INSERT INTO details_warehouse_entity
      (warehouse_id, entity_id, facility_code, type,
       bill_to_gstin, bill_to_name, bill_to_address,
       ship_to_gstin, ship_to_name,
       ship_to_line1, ship_to_line2, ship_to_city, ship_to_state, ship_to_pincode,
       ship_to_address, status, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      facility_code   = VALUES(facility_code),
      type            = VALUES(type),
      bill_to_gstin   = VALUES(bill_to_gstin),
      bill_to_name    = VALUES(bill_to_name),
      bill_to_address = VALUES(bill_to_address),
      ship_to_gstin   = VALUES(ship_to_gstin),
      ship_to_name    = VALUES(ship_to_name),
      ship_to_line1   = VALUES(ship_to_line1),
      ship_to_line2   = VALUES(ship_to_line2),
      ship_to_city    = VALUES(ship_to_city),
      ship_to_state   = VALUES(ship_to_state),
      ship_to_pincode = VALUES(ship_to_pincode),
      ship_to_address = VALUES(ship_to_address),
      status          = VALUES(status),
      remarks         = VALUES(remarks)
  `,

  // ============ UPDATE QUERIES ============

  /**
   * `name` is absent from the SET list on purpose: purchase_orders.destination,
   * invoice_mfg.destination and entity_emails.entity_code are unenforced copies
   * of it, so a rename orphans all three silently. tests/db/warehouse-approval
   * .test.ts pins this — if someone adds `name` here, that test fails.
   * `code` IS in the SET list, unlike `name`: nothing joins on it yet, so it is
   * safe to correct. If it ever becomes the join key that changes.
   * Parameters: [code, location, state, zone, type, contact_person,
   *   contact_phone, site_gstin, status, id]
   */
  update: `
    UPDATE master_warehouse
    SET code = ?, location = ?, state = ?, zone = ?, type = ?,
        contact_person = ?, contact_phone = ?, site_gstin = ?, status = ?
    WHERE id = ?
  `,

  /**
   * Set or clear one facility's ERP PO-code config.
   *
   * Both values may be NULL, and clearing po_short_code is the documented way to
   * back a pilot out: the facility returns to sending no purchaseOrderCode and
   * Uniware numbers the PO, exactly as before this feature existed.
   *
   * Deliberately NOT part of upsertEntityRow. That query is driven by the
   * WAREHOUSE approval diff and restates every column it touches, so folding
   * these in would put PO numbering behind an approval and — worse — silently
   * overwrite a configured short code with NULL on any warehouse edit that did
   * not carry it. This is a direct write, matching the facility-map route.
   *
   * Parameters: [po_short_code, po_seq_seed, facility_id]
   */
  updatePoConfig: `
    UPDATE details_warehouse_entity
    SET po_short_code = ?, po_seq_seed = ?
    WHERE id = ?
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Fetch one location. What the approval diff compares the proposed values
   *  against, so its column list is shared with selectAll — see the note on
   *  WAREHOUSE_COLUMNS.
   *  Parameters: [id] */
  selectById: `
    SELECT ${WAREHOUSE_COLUMNS}
    FROM master_warehouse w
    WHERE w.id = ? LIMIT 1
  `,

  /** One entity's row for one location, for the approval handler's per-entity
   *  diff. Returns nothing when this location has no row for that entity yet,
   *  which is why selectEntityIdByCode exists.
   *  Parameters: [warehouse_id, entity_code] */
  selectEntityRowByCode: `
    SELECT dwe.*, e.code AS entity_code
    FROM details_warehouse_entity dwe
    JOIN master_entity e ON e.id = dwe.entity_id
    WHERE dwe.warehouse_id = ? AND e.code = ?
    LIMIT 1
  `,

  /** Resolve an entity by its code, for writing a child row that doesn't exist
   *  yet and for the PAN cross-check on a submitted GSTIN — a valid GSTIN filed
   *  under the wrong entity is otherwise undetectable, since both are ours and
   *  isOurs() accepts either.
   *  Parameters: [entity_code] */
  selectEntityIdByCode: `SELECT id, code, pan FROM master_entity WHERE code = ? LIMIT 1`,

  /** Parameters: [status, id] */
  setStatus: `UPDATE master_warehouse SET status = ? WHERE id = ?`,
}
