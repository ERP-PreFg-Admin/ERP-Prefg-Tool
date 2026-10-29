-- What: report_snapshots, one row per (IST day, metric, manufacturer) written by the nightly job.
--
-- Why:  trends (docs/reporting/views-plan.md B9). The operational tables hold current state only, so
--       yesterday's open qty, fill % or exception count can't be recomputed later: history exists only
--       from the first night this runs. mfg_code '' is the all-manufacturers row (a PK column can't be NULL).
--
-- Re-runnable: YES (IF NOT EXISTS). The writer upserts, so re-running a night overwrites that night.
--
-- Applied to mcaff_prefg_dev and mcaff_prefg_prod on 2026-10-27. Writes start only when
-- REPORT_SNAPSHOTS_ENABLED=1 is set on a server (the job writes into this table).

CREATE TABLE IF NOT EXISTS report_snapshots (
  day        DATE          NOT NULL COMMENT 'IST date the numbers describe',
  metric     VARCHAR(64)   NOT NULL COMMENT 'lib/reports/snapshot-metrics.ts SNAPSHOT_METRICS',
  mfg_code   VARCHAR(50)   NOT NULL DEFAULT '' COMMENT 'master_mfgs.code; empty = all manufacturers',
  value      DECIMAL(18,3) NULL,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, metric, mfg_code),
  KEY idx_snap_metric_day (metric, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
