-- Manufacturing module overhaul (mfgId page): BOM version tracking + a
-- one-off cleanup for the removed "Tech Transfers" line status.
--
-- This is real MySQL 8.0 on RDS (not MariaDB, despite CLAUDE.md's description) —
-- MySQL does not support `ADD COLUMN IF NOT EXISTS`, so these are plain ALTERs.
--
-- rm_version/pm_version default to 1 so existing BOM rows are left untouched;
-- only newly created BOMs (see lib/masters/bom-version.ts) get real, independently
-- incrementing version numbers used in the new `<sku_code>RM<n>PM<n>` bom_code format.
ALTER TABLE master_bom ADD COLUMN rm_version INT NOT NULL DEFAULT 1;
ALTER TABLE master_bom ADD COLUMN pm_version INT NOT NULL DEFAULT 1;

-- The "Tech Transfers" tab/status is being removed from the manufacturing lines
-- UI. Any line still sitting in that status needs to land somewhere the UI still
-- recognizes before the app code that removes the status option deploys —
-- otherwise those lines become inaccessible/unrepresentable. Reassigned to
-- 'active' per user direction.
UPDATE master_bom_mfg SET status = 'active' WHERE status = 'tech_transfer';
