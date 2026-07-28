-- Adds the `remarks` free-text column to every master-data table that will
-- gain a Remarks input (Add dialog, Edit dialog, bulk upload).
--
-- This is real MySQL 8.0 on RDS (not MariaDB, despite CLAUDE.md's description) —
-- MySQL does not support `ADD COLUMN IF NOT EXISTS`, so these are plain ALTERs.
-- `details_mfg` already has this column on mcaff_prefg_dev (varchar(300), added
-- previously but never wired into the app) — if running this on dev, skip that
-- line or ignore the "Duplicate column name" error it raises there. On prod,
-- run all 9 lines as-is.

ALTER TABLE details_vendor  ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE details_mfg     ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE master_rm       ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE master_pm       ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE rm_mrm_fixed    ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE rm_vrm_dynamic  ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE pm_mrm_fixed    ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE pm_vrm_dynamic  ADD COLUMN remarks VARCHAR(300) NULL;
ALTER TABLE master_bom      ADD COLUMN remarks VARCHAR(300) NULL;
