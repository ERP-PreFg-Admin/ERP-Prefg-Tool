/**
 * User administration — `users` + `user_roles`.
 *
 * These are the only writes to `users` in the app. Everything else reads it:
 * lib/auth.ts' signIn callback whitelists on `email` + `status`, so a row must
 * exist here BEFORE someone can sign in with Google. There is deliberately no
 * delete — `users.id` is referenced by approvals, sessions, session_history,
 * master_* and supplier_invoices; deactivation is `status = 'inactive'`, which
 * signIn already refuses.
 */

/** Row shape of selectAll / selectById. `roles` is a comma-joined string (or null). */
export type AdminUser = {
  id: number
  name: string
  email: string
  status: string | null
  created_at: Date | string | null
  roles: string | null
  last_login: Date | string | null
}

export const usersSql = {
  /** All users with roles rolled up and last successful login. */
  selectAll: `
    SELECT
      u.id, u.name, u.email, u.status, u.created_at,
      GROUP_CONCAT(DISTINCT r.role ORDER BY r.role SEPARATOR ',') AS roles,
      (SELECT MAX(sh.event_at) FROM session_history sh
        WHERE sh.user_id = u.id AND sh.event = 'login') AS last_login
    FROM users u
    LEFT JOIN user_roles r ON r.user_id = u.id
    GROUP BY u.id, u.name, u.email, u.status, u.created_at
    ORDER BY u.name ASC
  `,

  /** Params: [id] */
  selectById: `
    SELECT
      u.id, u.name, u.email, u.status, u.created_at,
      GROUP_CONCAT(DISTINCT r.role ORDER BY r.role SEPARATOR ',') AS roles,
      (SELECT MAX(sh.event_at) FROM session_history sh
        WHERE sh.user_id = u.id AND sh.event = 'login') AS last_login
    FROM users u
    LEFT JOIN user_roles r ON r.user_id = u.id
    WHERE u.id = ?
    GROUP BY u.id, u.name, u.email, u.status, u.created_at
  `,

  /** Existence check for user_page_permissions overrides. Params: [id] */
  existsById: `SELECT id FROM users WHERE id = ? LIMIT 1`,

  /** Params: [name, email, status] */
  insertUser: `INSERT INTO users (name, email, status) VALUES (?, ?, ?)`,

  /** Params: [name, status, id] */
  updateUser: `UPDATE users SET name = ?, status = ? WHERE id = ?`,

  /** Params: [user_id, role] */
  insertRole: `
    INSERT INTO user_roles (user_id, role) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE role = VALUES(role)
  `,

  /** Params: [user_id] */
  deleteRoles: `DELETE FROM user_roles WHERE user_id = ?`,

  /**
   * Every role name known to the system. There is no `roles` table — role is a
   * free-text VarChar in both places it's stored, so the union of the two IS
   * the role list.
   */
  selectDistinctRoles: `
    SELECT role FROM (
      SELECT DISTINCT role FROM user_roles
      UNION
      SELECT DISTINCT role FROM page_permissions
    ) r
    WHERE role <> ''
    ORDER BY role ASC
  `,
}
