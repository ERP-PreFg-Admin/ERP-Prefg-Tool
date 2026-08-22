-- WHAT: renumbers active recipes whose variant family disagrees on rm_version
-- even though their RM lines are IDENTICAL. Data repair, not a schema change.
--
-- WHY: rm_version used to be counted from each SKU's OWN prior recipe, while RM
-- is a property of the whole variant family (the SKUs sharing a brand +
-- base_sku_sno are one formulation in different pack sizes). So a variant whose
-- first recipe was created after the base had already moved to RM2 got stamped
-- RM1 — one formulation wearing two version numbers. Fixed going forward by
-- resolveRecipeVersions in lib/masters/recipe-version.ts; this cleans up what
-- the old numbering already wrote.
--
-- Found on mcaff_prefg_dev on 2026-08-22:
--   Fein / 351   MCaf351=RM3, 20MCaf351=RM2   -- RM lines byte-identical
--
-- DRY-RUN VERIFIED on mcaff_prefg_dev (2026-08-22), executed inside a
-- transaction and rolled back. Result:
--   preview  -> recipe_id 30, 20MCaf351, RM2 -> RM3, new code 20MCaf351-RM3-PM1
--   update   -> Rows matched: 1  Changed: 1  Warnings: 0
--   after    -> the drift report returns zero rows
--   pm_version untouched on both (PM1 and PM2) — PM is per pack size
-- Not yet applied to either schema. Prod has not been surveyed.
--
-- SAFETY: this ONLY touches families whose active recipes have the exact same RM
-- line set (material, amount and uom). Those are pure mis-numberings, so
-- restamping is lossless — no formulation changes, no new version, nothing to
-- approve. A family whose RM lines genuinely DIFFER is left alone: that is a
-- real split formulation and needs a reviewed RM change submitted from the base
-- SKU in Recipe Master, which fans out to every sibling in one approval. Step 1
-- lists those separately so they are not silently forgotten.
--
-- Re-runnable: yes. It is idempotent — once a family agrees, it stops matching.
--
-- Run STEP 1 first and read the output. Only run STEP 2 if step 1's
-- "needs_manual_fix" list is empty or you have accepted leaving those alone.

-- ── STEP 1: report ──────────────────────────────────────────────────────────
-- One row per split family, saying which kind it is. `rm_fingerprint_count = 1`
-- means every member carries the same RM lines (safe to renumber below);
-- anything higher means the formulations really differ.
SELECT
  f.brand,
  f.base_sku_sno,
  COUNT(*)                        AS active_recipes,
  MIN(f.rm_version)               AS min_rm_version,
  MAX(f.rm_version)               AS max_rm_version,
  COUNT(DISTINCT f.rm_fingerprint) AS rm_fingerprint_count,
  CASE WHEN COUNT(DISTINCT f.rm_fingerprint) = 1
       THEN 'safe_to_renumber'
       ELSE 'needs_manual_fix'
  END                             AS verdict,
  GROUP_CONCAT(CONCAT(f.sku_code, '=RM', f.rm_version)
               ORDER BY f.sku_code SEPARATOR ', ') AS members
FROM (
  SELECT
    s.brand, s.base_sku_sno, s.sku_code, b.id AS recipe_id, b.rm_version,
    -- The RM line set, canonicalised: sorted, numeric amounts, lower-cased uom.
    -- Mirrors lineKey() in lib/masters/recipe-version.ts so SQL and TS agree on
    -- what "the same RM" means; '30.0000' and '30' must not read as different.
    (SELECT GROUP_CONCAT(
              CONCAT_WS(':', d.mtrl_id, CAST(d.amount + 0 AS CHAR), LOWER(TRIM(COALESCE(d.uom, ''))))
              ORDER BY d.mtrl_id SEPARATOR '|')
       FROM details_recipe d
      WHERE d.recipe_id = b.id AND d.mtrl_type = 'rm') AS rm_fingerprint
  FROM master_recipe b
  JOIN master_skus s ON s.id = b.sku_id
  WHERE b.status = 'active'
    AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
) f
GROUP BY f.brand, f.base_sku_sno
HAVING COUNT(*) > 1 AND MIN(f.rm_version) <> MAX(f.rm_version)
ORDER BY f.brand, f.base_sku_sno;

-- ── STEP 2: renumber the safe ones ──────────────────────────────────────────
-- Lifts every laggard to its family's highest rm_version and rewrites the
-- bom_code's RM segment to match. bom_code is rebuilt from the SKU code rather
-- than string-patched, because the old code may have been supplied by hand via a
-- CSV upload and need not follow the <sku>-RM<n>-PM<n> shape at all.
--
-- Wrapped in a transaction so a mistake is one ROLLBACK away.
--
-- Joins a DERIVED table rather than using a temp table: the app's DB user
-- (ERP_Tech_Admin) has no CREATE TEMPORARY TABLES privilege — a temp-table
-- version of this fails with "Access denied ... to database". MySQL 8.0
-- materialises the derived table, so reading master_recipe inside an UPDATE of
-- master_recipe is fine here; only a correlated subquery on the target would
-- raise ER_UPDATE_TABLE_USED.

START TRANSACTION;

-- Review before committing: exactly the rows the UPDATE below will change.
-- (Same derived table, run as a SELECT.)
SELECT
  f.recipe_id,
  f.sku_code,
  f.rm_version AS current_rm_version,
  g.max_rm_version AS target_rm_version,
  CONCAT(f.sku_code, '-RM', g.max_rm_version, '-PM', f.pm_version) AS new_bom_code
FROM (
  SELECT
    s.brand, s.base_sku_sno, s.sku_code,
    b.id AS recipe_id, b.rm_version, b.pm_version,
    (SELECT GROUP_CONCAT(
              CONCAT_WS(':', d.mtrl_id, CAST(d.amount + 0 AS CHAR), LOWER(TRIM(COALESCE(d.uom, ''))))
              ORDER BY d.mtrl_id SEPARATOR '|')
       FROM details_recipe d
      WHERE d.recipe_id = b.id AND d.mtrl_type = 'rm') AS rm_fingerprint
  FROM master_recipe b
  JOIN master_skus s ON s.id = b.sku_id
  WHERE b.status = 'active'
    AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
) f
JOIN (
  SELECT brand, base_sku_sno, MAX(rm_version) AS max_rm_version
  FROM (
    SELECT
      s.brand, s.base_sku_sno, b.rm_version,
      (SELECT GROUP_CONCAT(
                CONCAT_WS(':', d.mtrl_id, CAST(d.amount + 0 AS CHAR), LOWER(TRIM(COALESCE(d.uom, ''))))
                ORDER BY d.mtrl_id SEPARATOR '|')
         FROM details_recipe d
        WHERE d.recipe_id = b.id AND d.mtrl_type = 'rm') AS rm_fingerprint
    FROM master_recipe b
    JOIN master_skus s ON s.id = b.sku_id
    WHERE b.status = 'active'
      AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
  ) inner_f
  GROUP BY brand, base_sku_sno
  -- Only families that are split AND share one RM formulation.
  HAVING COUNT(*) > 1
     AND MIN(rm_version) <> MAX(rm_version)
     AND COUNT(DISTINCT rm_fingerprint) = 1
) g ON g.brand = f.brand AND g.base_sku_sno = f.base_sku_sno
WHERE f.rm_version <> g.max_rm_version;

UPDATE master_recipe b
JOIN (
  SELECT f.recipe_id, f.sku_code, f.pm_version, g.max_rm_version AS target_rm_version
  FROM (
    SELECT
      s.brand, s.base_sku_sno, s.sku_code,
      b2.id AS recipe_id, b2.rm_version, b2.pm_version,
      (SELECT GROUP_CONCAT(
                CONCAT_WS(':', d.mtrl_id, CAST(d.amount + 0 AS CHAR), LOWER(TRIM(COALESCE(d.uom, ''))))
                ORDER BY d.mtrl_id SEPARATOR '|')
         FROM details_recipe d
        WHERE d.recipe_id = b2.id AND d.mtrl_type = 'rm') AS rm_fingerprint
    FROM master_recipe b2
    JOIN master_skus s ON s.id = b2.sku_id
    WHERE b2.status = 'active'
      AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
  ) f
  JOIN (
    SELECT brand, base_sku_sno, MAX(rm_version) AS max_rm_version
    FROM (
      SELECT
        s.brand, s.base_sku_sno, b3.rm_version,
        (SELECT GROUP_CONCAT(
                  CONCAT_WS(':', d.mtrl_id, CAST(d.amount + 0 AS CHAR), LOWER(TRIM(COALESCE(d.uom, ''))))
                  ORDER BY d.mtrl_id SEPARATOR '|')
           FROM details_recipe d
          WHERE d.recipe_id = b3.id AND d.mtrl_type = 'rm') AS rm_fingerprint
      FROM master_recipe b3
      JOIN master_skus s ON s.id = b3.sku_id
      WHERE b3.status = 'active'
        AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
    ) inner_f
    GROUP BY brand, base_sku_sno
    HAVING COUNT(*) > 1
       AND MIN(rm_version) <> MAX(rm_version)
       AND COUNT(DISTINCT rm_fingerprint) = 1
  ) g ON g.brand = f.brand AND g.base_sku_sno = f.base_sku_sno
  WHERE f.rm_version <> g.max_rm_version
) t ON t.recipe_id = b.id
SET b.rm_version = t.target_rm_version,
    b.bom_code   = CONCAT(t.sku_code, '-RM', t.target_rm_version, '-PM', t.pm_version),
    b.updated_at = NOW();

-- Verify: re-run STEP 1. Every remaining row should read 'needs_manual_fix'.
COMMIT;
