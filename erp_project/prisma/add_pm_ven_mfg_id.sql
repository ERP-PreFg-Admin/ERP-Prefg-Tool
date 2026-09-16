-- WHAT: add a nullable `mfg_id` to cost_master_pm_ven, mirroring the column
-- cost_master_rm_ven has carried since the vendor-rate manufacturer tag was built.
--
-- WHY: the PM Cost Master by-vendor table had no Manufacturer column and could
-- not have one — the grain existed on the RM side only. Three places said so out
-- loud and all three are removed by the commit that carries this file:
--   lib/master-routes/material-utils.ts:286   (diff skipped mfg_id for PM_VRM)
--   lib/approvals/handlers/packing-materials.ts:264
--   prisma/schema.prisma  model pm_vrm_dynamic
--
-- The tag is INFORMATIONAL and deliberately NOT part of the rate key:
-- checkVendorRate stays (pm_id, vendor_id, moq), so tagging a rate never forks
-- it into one row per manufacturer. No FK — rm_vrm_dynamic.mfg_id has none
-- either, and a stricter PM side would be a surprise, not a safeguard.
--
-- RE-RUNNABLE: NO. MySQL 8.0 has no ADD COLUMN IF NOT EXISTS; a second run
-- errors on the duplicate column. Run once per schema (dev first, prod on its
-- own go-ahead).

ALTER TABLE cost_master_pm_ven
  ADD COLUMN mfg_id INT NULL AFTER vendor_code;

ALTER TABLE cost_master_pm_ven
  ADD INDEX idx_pm_ven_mfg (mfg_id);
