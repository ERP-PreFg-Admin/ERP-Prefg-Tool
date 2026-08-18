/**
 * Per-user entity scoping — `user_entity_scope`.
 *
 * Read by lib/scope.ts (once per request), written by
 * /api/v1/admin/entity-scope. See prisma/add_user_entity_scope.sql for why the
 * absence of rows means "unrestricted".
 */

export const entityScopeSql = {
  /** Every scope row for one user, all three entity types. Params: [user_id] */
  selectByUser: `
    SELECT entity_type, entity_id
    FROM user_entity_scope
    WHERE user_id = ?
  `,

  /**
   * Warehouse ids -> the names purchase_orders.destination actually stores.
   * Params: [ids] (array — expanded by query()'s text protocol)
   */
  warehouseNamesByIds: `
    SELECT id, name FROM master_warehouse WHERE id IN (?)
  `,

  /** Params: [user_id, entity_type] */
  deleteForUserAndType: `
    DELETE FROM user_entity_scope WHERE user_id = ? AND entity_type = ?
  `,

  /** Params: [user_id, entity_type, entity_id, created_by] */
  insert: `
    INSERT INTO user_entity_scope (user_id, entity_type, entity_id, created_by)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE entity_id = VALUES(entity_id)
  `,

  /** Assignable entities for the admin picker — one query per type. */
  mfgOptions: `
    SELECT m.id, m.code, m.name
    FROM master_mfgs m
    LEFT JOIN details_mfg d ON d.mfg_id = m.id
    ORDER BY m.code ASC
  `,
  vendorOptions: `
    SELECT id, code, name FROM master_vendors ORDER BY code ASC
  `,
  warehouseOptions: `
    SELECT id, name AS code, name FROM master_warehouse ORDER BY name ASC
  `,

  brandOptions: `
    SELECT id, po_code AS code , name
    FROM master_brand 
    WHERE status = 'active'
    ORDER By name ASC
  `,

  /** Per-user assigned counts, for the "who is scoped" summary on the tab. */
  countsByUser: `
    SELECT user_id, entity_type, COUNT(*) AS assigned
    FROM user_entity_scope
    GROUP BY user_id, entity_type
  `,
}
