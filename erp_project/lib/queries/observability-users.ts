// Per-user activity for /observability > Logs > By user. Same sources as /admin > Activity.
// `? IS NULL OR` filters need query() (text protocol), not execute().

export const observabilityUsersSql = {
  /** One row per (user, route) in the window; modules are folded from route in TS.
   *  Params: [from, to, user_id, user_id] */
  userRouteStats: `
    SELECT a.user_id,
           MAX(u.name)                              AS user_name,
           REGEXP_REPLACE(a.path, '/[0-9]+', '/:id') AS route,
           COUNT(*)                                 AS calls,
           SUM(a.status BETWEEN 400 AND 499)        AS err_4xx,
           SUM(a.status >= 500)                     AS err_5xx,
           MAX(a.duration_ms)                       AS max_ms,
           MAX(a.created_on)                        AS last_at
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_on >= ? AND a.created_on < ?
      AND a.user_id IS NOT NULL
      AND (? IS NULL OR a.user_id = ?)
    GROUP BY a.user_id, route
  `,

  /** Last sign-in ever (up to `to`) and last session event inside the window, per user.
   *  Params: [from, to, user_id, user_id] */
  userSessions: `
    SELECT sh.user_id,
           MAX(u.name)                                            AS user_name,
           MAX(CASE WHEN sh.event = 'login' THEN sh.event_at END) AS last_sign_in,
           MAX(CASE WHEN sh.event_at >= ? THEN sh.event_at END)   AS last_in_window
    FROM session_history sh
    LEFT JOIN users u ON u.id = sh.user_id
    WHERE sh.event_at < ?
      AND (? IS NULL OR sh.user_id = ?)
    GROUP BY sh.user_id
  `,

  /** Calls and session events for one user, newest first. errorsOnly drops sign-ins too.
   *  Params: [user_id, from, to, errors_only, user_id, from, to, errors_only, limit] */
  userTimeline: `
    SELECT * FROM (
      SELECT a.created_on AS at, 'request' AS source, a.method, a.path AS detail,
             a.status, a.duration_ms, a.request_id, a.ip_address
      FROM activity_log a
      WHERE a.user_id = ? AND a.created_on >= ? AND a.created_on < ?
        AND (? = 0 OR a.status >= 400)
      UNION ALL
      SELECT sh.event_at, 'session', NULL, sh.event, NULL, NULL, NULL, sh.ip_address
      FROM session_history sh
      WHERE sh.user_id = ? AND sh.event_at >= ? AND sh.event_at < ?
        AND ? = 0
    ) t
    ORDER BY t.at DESC
    LIMIT ?
  `,

  /** Params: [user_id] */
  userById: `SELECT id, name, email FROM users WHERE id = ?`,
}
