/**
 * Permissions Queries
 * Centralized queries for page_permissions and user_page_permissions
 */

export const permissions = {
  // ============ PAGE PERMISSIONS (Role-based) ============

  /**
   * Get all page permissions (role-based)
   * Returns: [{ role, page_slug, access_level }, ...]
   */
  selectPagePermissions: `
    SELECT * FROM page_permissions 
    ORDER BY role ASC, page_slug ASC
  `,

  /**
   * Get page permission for specific role and page
   * Returns: { role, page_slug, access_level }
   * Parameters: [role, page_slug]
   */
  selectPagePermissionByRoleAndPage: `
    SELECT * FROM page_permissions 
    WHERE role = ? AND page_slug = ? LIMIT 1
  `,

  /**
   * Insert or update page permission (upsert)
   * Parameters: [role, page_slug, access_level, access_level]
   * Note: Last param is for ON DUPLICATE KEY UPDATE clause
   */
  upsertPagePermission: `
    INSERT INTO page_permissions (role, page_slug, access_level)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE access_level = VALUES(access_level)
  `,

  /**
   * Remove a role's grant for a page entirely, so the slug falls back to its
   * parent again (lib/permissions.ts walks slugs upward). An explicit
   * access_level = 'none' row BLOCKS that fallback — deleting is how the
   * permissions grid sets a cell back to "inherit".
   * Parameters: [role, page_slug]
   */
  deletePagePermission: `
    DELETE FROM page_permissions
    WHERE role = ? AND page_slug = ?
  `,

  // ============ USER PAGE PERMISSIONS (User-specific) ============

  /**
   * Get all user page permissions
   * Returns: [{ user_id, page_slug, access_level }, ...]
   */
  selectUserPagePermissions: `
    SELECT * FROM user_page_permissions 
    ORDER BY user_id ASC, page_slug ASC
  `,

  /**
   * Get user page permissions for specific user
   * Returns: [{ user_id, page_slug, access_level }, ...]
   * Parameters: [user_id]
   */
  selectUserPagePermissionsByUserId: `
    SELECT * FROM user_page_permissions 
    WHERE user_id = ? 
    ORDER BY user_id ASC, page_slug ASC
  `,

  /**
   * Get user page permission for specific user and page
   * Returns: { user_id, page_slug, access_level }
   * Parameters: [user_id, page_slug]
   */
  selectUserPagePermissionByUserAndPage: `
    SELECT * FROM user_page_permissions 
    WHERE user_id = ? AND page_slug = ? LIMIT 1
  `,

  /**
   * Insert or update user page permission (upsert)
   * Parameters: [user_id, page_slug, access_level, access_level]
   * Note: Last param is for ON DUPLICATE KEY UPDATE clause
   */
  upsertUserPagePermission: `
    INSERT INTO user_page_permissions (user_id, page_slug, access_level)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE access_level = VALUES(access_level)
  `,

  /**
   * Delete user page permission
   * Parameters: [user_id, page_slug]
   */
  deleteUserPagePermission: `
    DELETE FROM user_page_permissions 
    WHERE user_id = ? AND page_slug = ?
  `,
}
