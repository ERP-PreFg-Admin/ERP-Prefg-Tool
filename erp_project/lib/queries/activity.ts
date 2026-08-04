/**
 * User activity trail — `activity_log` (see prisma/add_activity_log.sql).
 *
 * Written from exactly one place, lib/gateway/with-gateway.ts, so every API
 * mutation is captured without per-route instrumentation. Read by
 * /api/admin/activity.
 */

/**
 * The activity feed unions API mutations with login/logout events so both
 * appear on one timeline — session_history is the only record of sign-ins and
 * it predates activity_log.
 *
 * `? IS NULL OR` filters mean this MUST go through `query()` (text protocol),
 * not `execute()` — see lib/db.ts.
 */
const feed = `
  SELECT
    a.created_on                        AS at,
    a.user_id,
    u.name                              AS user_name,
    'request'                           AS source,
    a.method,
    a.path                              AS detail,
    a.status,
    a.duration_ms,
    a.ip_address
  FROM activity_log a
  LEFT JOIN users u ON u.id = a.user_id
  UNION ALL
  SELECT
    sh.event_at,
    sh.user_id,
    u.name,
    'session',
    NULL,
    sh.event,
    NULL,
    NULL,
    sh.ip_address
  FROM session_history sh
  LEFT JOIN users u ON u.id = sh.user_id
`

/** Params: [user_id, user_id, from, from, to, to, method, method, path, path] */
const filters = `
  WHERE (? IS NULL OR t.user_id = ?)
    AND (? IS NULL OR t.at >= ?)
    AND (? IS NULL OR t.at <= ?)
    AND (? IS NULL OR t.method = ?)
    AND (? IS NULL OR t.detail LIKE ?)
`

export const activitySql = {
  /** Params: [user_id, method, path, status, duration_ms, ip_address, user_agent, request_id] */
  insert: `
    INSERT INTO activity_log
      (user_id, method, path, status, duration_ms, ip_address, user_agent, request_id, created_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CONVERT_TZ(NOW(), '+00:00', '+05:30'))
  `,

  /** Params: [...filters, limit, offset] */
  selectPaginated: `
    SELECT * FROM (${feed}) t
    ${filters}
    ORDER BY t.at DESC
    LIMIT ? OFFSET ?
  `,

  /** Params: [...filters] */
  countFiltered: `
    SELECT COUNT(*) AS total FROM (${feed}) t
    ${filters}
  `,

  /** Users who have any activity, for the filter dropdown. */
  selectActors: `
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    WHERE EXISTS (SELECT 1 FROM activity_log a WHERE a.user_id = u.id)
       OR EXISTS (SELECT 1 FROM session_history sh WHERE sh.user_id = u.id)
    ORDER BY u.name
  `,
}
