-- Manufacturing line status now has 3 values (active, discontinued, inactive)
-- instead of 2 (active, on_hold). Existing rows previously set to 'on_hold'
-- become 'inactive' (POs can no longer be raised against them) — there's no
-- way to retroactively know which of these were meant as the new
-- 'discontinued' (still-live, winding-down) state, so they default to the
-- more restrictive 'inactive' and can be manually reclassified if wrong.
--
-- master_bom_mfg.status is VARCHAR(50), not a DB ENUM, so no ALTER is needed
-- to add the new 'discontinued' value — this is purely a data migration.
UPDATE master_bom_mfg SET status = 'inactive' WHERE status = 'on_hold';
