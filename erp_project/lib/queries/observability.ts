/** Request metrics over activity_log — /observability > Requests.
 *  Only non-GET requests are recorded (plus slow/failing GETs after Phase 2). */

// Numeric segments collapse to /:id, or every PO id becomes its own route row.
const route = (col = "path") => `REGEXP_REPLACE(${col}, '/[0-9]+', '/:id')`

export const observabilitySql = {
  /** Params: [from, to] */
  routeStats: `
    WITH norm AS (
      SELECT ${route()} AS route, method, duration_ms, status, created_on
      FROM activity_log
      WHERE created_on >= ? AND created_on < ?
    ),
    ranked AS (
      SELECT route, method, duration_ms, status, created_on,
             ROW_NUMBER() OVER (PARTITION BY route ORDER BY duration_ms) AS rn,
             COUNT(*)     OVER (PARTITION BY route)                      AS n
      FROM norm
    )
    SELECT route,
           -- One route can be hit by several verbs; POST and DELETE on the same
           -- path are different operations sharing a latency profile.
           GROUP_CONCAT(DISTINCT method ORDER BY method)             AS methods,
           MAX(n)                                                    AS calls,
           MAX(CASE WHEN rn = CEIL(n * 0.50) THEN duration_ms END)   AS p50_ms,
           MAX(CASE WHEN rn = CEIL(n * 0.95) THEN duration_ms END)   AS p95_ms,
           MAX(duration_ms)                                          AS max_ms,
           SUM(status BETWEEN 400 AND 499)                            AS err_4xx,
           SUM(status >= 500)                                         AS err_5xx,
           -- Answers "is this still happening", which a percentile can't.
           MAX(created_on)                                            AS last_at
    FROM ranked
    GROUP BY route
    ORDER BY p95_ms DESC
  `,

  /** Params: [from, to] — hours with no traffic are ABSENT; the caller fills gaps. */
  hourlySeries: `
    SELECT DATE_FORMAT(created_on, '%Y-%m-%d %H:00:00') AS bucket,
           COUNT(*)                AS calls,
           SUM(status >= 400)      AS errors,
           ROUND(AVG(duration_ms)) AS avg_ms
    FROM activity_log
    WHERE created_on >= ? AND created_on < ?
    GROUP BY bucket
    ORDER BY bucket
  `,

  /** Params: [from, to] — one row, all-NULL metrics when the window is empty. */
  windowSummary: `
    WITH ranked AS (
      SELECT duration_ms, status,
             ROW_NUMBER() OVER (ORDER BY duration_ms) AS rn,
             COUNT(*)     OVER ()                     AS n
      FROM activity_log
      WHERE created_on >= ? AND created_on < ?
    )
    SELECT COALESCE(MAX(n), 0)                                      AS calls,
           MAX(CASE WHEN rn = CEIL(n * 0.50) THEN duration_ms END)  AS p50_ms,
           MAX(CASE WHEN rn = CEIL(n * 0.95) THEN duration_ms END)  AS p95_ms,
           COALESCE(SUM(status BETWEEN 400 AND 499), 0)             AS err_4xx,
           COALESCE(SUM(status >= 500), 0)                          AS err_5xx
    FROM ranked
  `,

  /** Params: [from, to, slow_ms, limit] */
  recentProblems: `
    SELECT a.created_on          AS at,
           a.method,
           ${route("a.path")}    AS route,
           a.status,
           a.duration_ms,
           a.request_id,
           u.name                AS user_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_on >= ? AND a.created_on < ?
      AND (a.status >= 400 OR a.duration_ms >= ?)
    ORDER BY (a.status >= 400) DESC, a.duration_ms DESC
    LIMIT ?
  `,
}
