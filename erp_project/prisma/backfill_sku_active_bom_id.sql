-- WHAT: point master_skus.active_bom_id at each SKU's active Recipe.
--
-- WHY: the column is only written on the Recipe APPROVAL path (bomHandler /
-- bomBulkHandler applyAndArchive, and the update-status action, via
-- lib/queries/skus.ts's setActiveBomId / clearActiveBomIdIfMatches). Any Recipe
-- that became active another way — seeded, legacy, or created before that code
-- landed — leaves the pointer NULL, and the SKU master list resolves its Recipe
-- column from that pointer alone. The row then reads "No Recipe" while the
-- Recipe plainly exists.
--
-- The 2026-08 rename dropped master_bom; this file still said master_bom and so
-- errored instead of running. Retargeted to master_recipe.
--
-- RE-RUNNABLE: yes, both statements are idempotent.

-- Set/repair the pointer. MAX(id) makes the choice deterministic if a SKU ever
-- ends up with more than one active Recipe — approval enforces one, but this
-- file also runs over data that never went through approval.
UPDATE master_skus s
JOIN (
  SELECT sku_id, MAX(id) AS recipe_id
  FROM master_recipe
  WHERE status = 'active' AND sku_id IS NOT NULL
  GROUP BY sku_id
) b ON b.sku_id = s.id
SET s.active_bom_id = b.recipe_id
WHERE s.active_bom_id IS NULL OR s.active_bom_id <> b.recipe_id;

-- Clear the pointer where it references a Recipe that isn't active any more.
UPDATE master_skus s
LEFT JOIN master_recipe b ON b.id = s.active_bom_id AND b.status = 'active'
SET s.active_bom_id = NULL
WHERE s.active_bom_id IS NOT NULL AND b.id IS NULL;
