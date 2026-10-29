// report_snapshots (prisma/add_report_snapshots.sql): nightly metric rows behind the trends view.

export const snapshotsSql = {
  /** Params: rows flattened as [day, metric, mfg_code, value] × n; build the VALUES with valuesPlaceholders(n). */
  upsert: (n: number) => `
    INSERT INTO report_snapshots (day, metric, mfg_code, value)
    VALUES ${Array.from({ length: n }, () => "(?, ?, ?, ?)").join(", ")}
    ON DUPLICATE KEY UPDATE value = VALUES(value), created_at = CURRENT_TIMESTAMP
  `,
  /** One manufacturer's ('' = all) series for the given metrics since a day. Params: [mfg, metrics[], fromDay]. */
  series: `
    SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, metric, value
    FROM report_snapshots
    WHERE mfg_code = ? AND metric IN (?) AND day >= ?
    ORDER BY metric, day
  `,
  /** Every manufacturer's latest value per metric, for the scorecard league. Params: [metrics[]]. */
  latestPerMfg: `
    SELECT s.mfg_code, s.metric, s.value, DATE_FORMAT(s.day, '%Y-%m-%d') AS day
    FROM report_snapshots s
    JOIN (SELECT metric, mfg_code, MAX(day) AS day FROM report_snapshots WHERE metric IN (?) GROUP BY metric, mfg_code) l
      ON l.metric = s.metric AND l.mfg_code = s.mfg_code AND l.day = s.day
  `,
  mfgCodes: "SELECT code FROM master_mfgs ORDER BY code",
  /** Params: [ids[]] (query() expands the array). */
  mfgCodesByIds: "SELECT code FROM master_mfgs WHERE id IN (?)",
  /** Whole days since any GRN was last synced (NULL = never). */
  grnSyncAgeDays: "SELECT DATEDIFF(UTC_TIMESTAMP(), MAX(synced_at)) AS days FROM grn_uniware",
  firstDay:`SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') AS first_day, DATE_FORMAT(MAX(day), '%Y-%m-%d') AS last_day FROM report_snapshots`,
}
