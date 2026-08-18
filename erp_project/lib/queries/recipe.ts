/**
 * Recipe Queries
 * Centralized queries for master_recipe, details_recipe, and history_recipe.
 *
 * Real schema (verify against prisma/schema.prisma before adding queries —
 * master_recipe has NO sku_code/mfg_id columns, only sku_id):
 *   master_recipe(id, bom_code, sku_id, status, created_by, created_at, updated_by,
 *              updated_at, effective_from, effective_till, rm_version, pm_version)
 *   details_recipe(id, recipe_id → master_recipe.id, mtrl_type, mtrl_id, amount, uom,
 *               status, updated_by, last_updated)
 *   history_recipe — same shape as details_recipe plus mtrl_cost, approved_by, approved_on
 *
 * effective_from/effective_till live ONLY on the Recipe HEADER (master_recipe), one
 * pair per recipe — never per RM/PM line (details_recipe/history_recipe carried
 * legacy copies of these columns before this convention was settled; they've
 * since been dropped — see prisma/drop_bom_line_level_dates.sql). effective_from
 * is entered by the user when the Recipe is created/edited; effective_till is set
 * automatically (to the approval date) when a Recipe is discontinued/superseded
 * by a new, overlapping version.
 *
 * IMPORTANT: master_bom_status's "in_review" enum member is @map("in review")
 * in prisma/schema.prisma — the ACTUAL value stored in the DB column has a
 * space, unlike every other module's status column (STATUS.IN_REVIEW =
 * "in_review", no space). Never write STATUS.IN_REVIEW to master_recipe.status —
 * use RECIPE_STATUS_IN_REVIEW below, or the write silently fails/rolls back.
 */

import { SQL_TODAY_IST } from "@/lib/date"

export const RECIPE_STATUS_IN_REVIEW = "in review"

/**
 * Correlated subqueries resolving a Recipe header's own "__reason__" /
 * "__change_type__" sentinel approval_items (written by create-full's
 * new-version/update-existing submit — see app/api/v1/masters/recipe-master/route.ts
 * and RecipeLineDiffTable.tsx for the write/read counterparts). Picks the most
 * recently raised Recipe approval for that recipe_id in the rare case more than one
 * exists (e.g. a rejected-then-resubmitted edit). NULL when the Recipe was never
 * submitted with this metadata (a SKU's first-ever Recipe, or a bulk upload).
 */
const CHANGE_REASON_SUBQUERY = `(
  SELECT ai.new_value
  FROM approvals a
  JOIN approval_items ai ON ai.approval_id = a.id AND ai.field_name = '__reason__'
  WHERE a.module = 'BOM' AND a.entity_id = b.id
  ORDER BY a.raised_on DESC LIMIT 1
)`
const CHANGE_TYPE_SUBQUERY = `(
  SELECT ai.new_value
  FROM approvals a
  JOIN approval_items ai ON ai.approval_id = a.id AND ai.field_name = '__change_type__'
  WHERE a.module = 'BOM' AND a.entity_id = b.id
  ORDER BY a.raised_on DESC LIMIT 1
)`

/**
 * Correlated subqueries resolving how many manufacturers (and which ones)
 * currently produce this Recipe — master_recipe_mfg.status = 'active' is this
 * table's own "live" marker (see prisma/rename_mfg_line_on_hold_to_inactive.sql),
 * unrelated to master_recipe.status. Feeds the Recipe list's "Live Mfgs" column
 * (count + hover tooltip of manufacturer code/name).
 */
const LIVE_MFG_COUNT_SUBQUERY = `(
  SELECT COUNT(*)
  FROM master_recipe_mfg mbm
  WHERE mbm.recipe_id = b.id AND mbm.status = 'active'
)`
const LIVE_MFG_NAMES_SUBQUERY = `(
  SELECT GROUP_CONCAT(CONCAT(m.code, ' — ', m.name) ORDER BY m.name SEPARATOR ', ')
  FROM master_recipe_mfg mbm
  JOIN master_mfgs m ON m.id = mbm.mfg_id
  WHERE mbm.recipe_id = b.id AND mbm.status = 'active'
)`

export const bom = {
  // ============ SELECT QUERIES ============

  /**
   * Get all Recipe records with detail lines joined.
   * Returns full columns from both bom and bom_details.
   */
  selectAll: `
    SELECT
      b.bom_code, bd.recipe_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_recipe AS bd
    INNER JOIN master_recipe AS b ON b.id = bd.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    ORDER BY b.bom_code ASC
  `,

  // ============ PAGINATED SELECT QUERIES ============

  /**
   * Paginated Recipe list with optional search, material-type, and status filters.
   * Params: [like×3, brandScope×2, type×2, status×2, LIMIT, OFFSET]
   *   like   — '%search%' or null (bom_code / sku_code columns)
   *   type   — 'rm'|'pm' or null
   *   status — 'draft'|'active'|'inactive' or null
   */
  selectPaginated: `
    SELECT
      b.bom_code, bd.recipe_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_recipe AS bd
    INNER JOIN master_recipe AS b ON b.id = bd.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching Recipe rows for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated.
   * Params: [like×3, brandScope×2, type×2, status×2]
   */
  selectAllFiltered: `
    SELECT
      b.bom_code, bd.recipe_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_recipe AS bd
    INNER JOIN master_recipe AS b ON b.id = bd.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
  `,

  /**
   * Matching COUNT for selectPaginated.
   * Params: [like×3, brandScope×2, type×2, status×2]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM details_recipe AS bd
    INNER JOIN master_recipe AS b ON b.id = bd.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
  `,

  /**
   * Does this SKU already have an ACTIVE Recipe? Params: [sku_id]
   */
  selectActiveBomBySkuId: `
    SELECT b.id AS recipe_id, b.bom_code, b.status
    FROM master_recipe AS b
    WHERE b.sku_id = ? AND b.status = 'active'
    LIMIT 1
  `,

  /**
   * All Recipes (any status) for a SKU, newest first — used to suggest the next
   * version's bom_code. Params: [sku_id]
   */
  selectBomsBySkuId: `
    SELECT id AS recipe_id, bom_code, status, created_at
    FROM master_recipe
    WHERE sku_id = ?
    ORDER BY created_at DESC
  `,

  /**
   * The single most recent Recipe for a SKU (any status — the prior Recipe to diff
   * a new version against may be `discontinued` per the "2 Recipes live"
   * definition, so an active-only query would miss it), with its rm/pm
   * version numbers for independent-version bom_code generation. Params: [sku_id]
   */
  selectMostRecentBomForSku: `
    SELECT id, bom_code, rm_version, pm_version
    FROM master_recipe
    WHERE sku_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `,

  /**
   * Every active SKU whose active Recipe references this material — portfolio-wide,
   * used by the RM/PM vendor-rate edit dialogs' cost-impact alert.
   * Params: [mtrl_type, mtrl_id]
   */
  selectActiveSkusUsingMaterial: `
    SELECT DISTINCT s.sku_code, s.name
    FROM details_recipe bd
    INNER JOIN master_recipe b ON b.id = bd.recipe_id AND b.status = 'active'
    INNER JOIN master_skus s ON s.id = b.sku_id
    WHERE bd.mtrl_type = ? AND bd.mtrl_id = ? AND bd.status = 'active'
    ORDER BY s.sku_code ASC
  `,

  /**
   * Same as selectActiveSkusUsingMaterial, but narrowed to SKUs one specific
   * manufacturer actually produces (via master_recipe_mfg) — used by the RM/PM
   * manufacturer-rate edit dialogs' cost-impact alert.
   * Params: [mfg_id, mtrl_type, mtrl_id]
   */
  selectActiveSkusUsingMaterialForMfg: `
    SELECT DISTINCT s.sku_code, s.name
    FROM details_recipe bd
    INNER JOIN master_recipe b ON b.id = bd.recipe_id AND b.status = 'active'
    INNER JOIN master_recipe_mfg mbm ON mbm.recipe_id = b.id AND mbm.status = 'active' AND mbm.mfg_id = ?
    INNER JOIN master_skus s ON s.id = b.sku_id
    WHERE bd.mtrl_type = ? AND bd.mtrl_id = ? AND bd.status = 'active'
    ORDER BY s.sku_code ASC
  `,

  /**
   * Bare header lookup for existence/status checks before mutating. Includes
   * effective_from so callers (bomHandler.applyAndArchive, the update-status
   * action) can pass it straight into the overlap-aware discontinue query
   * without a second round-trip. Params: [id]
   */
  selectBomHeaderRawById: `
    SELECT id, bom_code, sku_id, status, created_by, effective_from
    FROM master_recipe
    WHERE id = ?
  `,

  /**
   * Bulk bom_code + status lookup by id — resolves master_skus.active_bom_id
   * to a display code for a whole page of SKU rows in one query. Params: [ids[]]
   */
  selectBomCodesByIds: `
    SELECT id, bom_code, status
    FROM master_recipe
    WHERE id IN (?)
  `,

  /**
   * All current detail lines for a Recipe, raw columns (no name/code joins) —
   * used to snapshot into history_recipe and to diff against a proposed line set.
   * Params: [recipe_id]
   */
  selectDetailLinesRawByBomId: `
    SELECT id, recipe_id, mtrl_type, mtrl_id, amount, uom, status, updated_by
    FROM details_recipe
    WHERE recipe_id = ?
    ORDER BY mtrl_type ASC, mtrl_id ASC
  `,

  /**
   * Paginated Recipe listing, ONE ROW PER Recipe HEADER (not per material line).
   * effective_from/effective_till are the Recipe header's own columns (recipe-
   * level, not aggregated from lines). change_reason/change_type are pulled
   * from this Recipe's own creating/editing approval — see the "__reason__" /
   * "__change_type__" sentinel approval_items written by the create-full
   * action (app/api/v1/masters/recipe-master/route.ts) and rendered by
   * RecipeLineDiffTable.tsx elsewhere; NULL for a SKU's very first Recipe or a
   * bulk-uploaded one, neither of which collects this metadata.
   * Params: [like, like, like, status, status, LIMIT, OFFSET]
   */
  selectPaginatedGrouped: `
    SELECT
      b.id AS recipe_id, b.bom_code, s.sku_code, s.name AS sku_name,
      b.created_at, b.effective_from, b.effective_till,
      b.status AS status,
      ${CHANGE_REASON_SUBQUERY} AS change_reason,
      ${CHANGE_TYPE_SUBQUERY} AS change_type,
      ${LIVE_MFG_COUNT_SUBQUERY} AS live_mfg_count,
      ${LIVE_MFG_NAMES_SUBQUERY} AS live_mfg_names
    FROM master_recipe AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching Recipe headers (no LIMIT/OFFSET) — feeds the fuzzy-search
   * ranking path (lib/fuzzy-search.ts) when a search term is present. Same
   * shape/WHERE as selectPaginatedGrouped.
   * Params: [like×3, brandScope×2, status×2]
   */
  selectAllFilteredGrouped: `
    SELECT
      b.id AS recipe_id, b.bom_code, s.sku_code, s.name AS sku_name,
      b.created_at, b.effective_from, b.effective_till,
      b.status AS status,
      ${CHANGE_REASON_SUBQUERY} AS change_reason,
      ${CHANGE_TYPE_SUBQUERY} AS change_type,
      ${LIVE_MFG_COUNT_SUBQUERY} AS live_mfg_count,
      ${LIVE_MFG_NAMES_SUBQUERY} AS live_mfg_names
    FROM master_recipe AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
  `,

  /**
   * Matching COUNT for selectPaginatedGrouped (one Recipe header = one row).
   * Params: [like×3, brandScope×2, status×2]
   */
  countGrouped: `
    SELECT COUNT(*) AS total
    FROM master_recipe AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR s.brand_id IS NULL OR s.brand_id IN (?))
      AND (? IS NULL OR b.status = ?)
  `,

  /**
   * Recipe header for the detail side-panel. Params: [recipe_id]
   */
  selectHeaderById: `
    SELECT b.id AS recipe_id, b.bom_code, b.sku_id, s.sku_code, b.status, b.created_at,
      b.effective_from, b.effective_till
    FROM master_recipe AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.id = ?
  `,

  /**
   * All material lines for a Recipe, for the detail side-panel. Params: [recipe_id]
   * Resolves the material's name/code from master_rm or master_pm depending
   * on mtrl_type, since details_recipe only stores a bare mtrl_id.
   */
  selectDetailLinesByBomId: `
    SELECT
      b.bom_code, bd.recipe_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      bd.last_updated,
      b.created_by,
      COALESCE(rm.name, pm.name) AS mtrl_name,
      COALESCE(rm.rm_code, pm.pm_code) AS mtrl_code,
      COALESCE(rm.status, pm.status) AS mtrl_master_status
    FROM details_recipe AS bd
    INNER JOIN master_recipe AS b ON b.id = bd.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN master_rm AS rm ON rm.id = bd.mtrl_id AND bd.mtrl_type = 'rm'
    LEFT JOIN master_pm AS pm ON pm.id = bd.mtrl_id AND bd.mtrl_type = 'pm'
    WHERE bd.recipe_id = ?
    ORDER BY bd.mtrl_type ASC, bd.mtrl_id ASC
  `,

  // ============ WRITE QUERIES ============

  /**
   * Insert a new Recipe header, stamping rm_version/pm_version — used by both
   * the single-Recipe wizard/edit path (app/api/v1/masters/recipe-master/route.ts) and
   * the CSV bulk path (lib/approvals/handlers/bom.ts), which now share the
   * same lib/masters/bom-version.ts diffBomLines-driven <sku>-RM<n>-PM<n>
   * version scheme regardless of upload type.
   * Parameters: [bom_code, sku_id, created_by, status, effective_from, rm_version, pm_version]
   */
  insertBomHeaderWithVersions: `
    INSERT INTO master_recipe (bom_code, sku_id, created_by, status, effective_from, rm_version, pm_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `,

  /**
   * Insert a single Recipe detail line. Only ever called at approval time (see
   * lib/approvals/module-handlers.ts bomHandler) — never at submission time.
   * effective_from/effective_till are recipe-level (master_recipe), not per line —
   * this table's own columns of the same name are left NULL for new lines and
   * only remain populated on legacy/history rows.
   * Parameters: [recipe_id, mtrl_type, mtrl_id, amount, uom, status, updated_by]
   */
  insertDetailLine: `
    INSERT INTO details_recipe
      (recipe_id, mtrl_type, mtrl_id, amount, uom, status, updated_by, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `,

  /**
   * Archive one detail line snapshot into history_recipe — written at approval
   * time for EVERY approved Recipe version (both "new-version" and the legacy
   * "update-existing" in-place edit), so the History page has a full
   * line-level record of every edit, per SKU, regardless of mode.
   * updated_by is the user who SUBMITTED this edit; approved_by/approved_on
   * are the user/time it was approved (same transaction as the approval).
   * Parameters: [recipe_id, mtrl_type, mtrl_id, amount, uom, mtrl_cost, status, updated_by, approved_by]
   */
  archiveDetailLineToHistory: `
    INSERT INTO history_recipe
      (recipe_id, mtrl_type, mtrl_id, amount, uom, mtrl_cost, status, updated_by, last_updated, approved_by, approved_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
  `,

  /**
   * Delete all current detail lines for a Recipe before re-inserting the new
   * set — used by the "update existing in place" apply step, AFTER archiving.
   * Parameters: [recipe_id]
   */
  deleteDetailLinesByBomId: `
    DELETE FROM details_recipe WHERE recipe_id = ?
  `,

  /** Parameters: [status, recipe_id] */
  setBomStatus: `
    UPDATE master_recipe SET status = ?, updated_at = NOW() WHERE id = ?
  `,

  /** Parameters: [status, updated_by, recipe_id] */
  setBomStatusWithUpdater: `
    UPDATE master_recipe SET status = ?, updated_by = ?, updated_at = NOW() WHERE id = ?
  `,

  /**
   * IDs of every OTHER active Recipe for the same sku_id, read BEFORE
   * discontinueOverlappingActiveBomsForSku runs — MariaDB's UPDATE has no
   * RETURNING, so this is how the caller knows which Recipes it's about to
   * deactivate (one bom.deactivated event per id, per event-catalog.md's
   * fan-out design). Used for the pre-flight "existing active Recipe" warning
   * too, where it's purely informational (no mutation follows).
   * Parameters: [sku_id, keep_bom_id]
   */
  selectOtherActiveBomsForSku: `
    SELECT id
    FROM master_recipe
    WHERE sku_id = ? AND id <> ? AND status = 'active'
  `,

  /**
   * Flip every OTHER active Recipe for the same sku_id to discontinued, but
   * ONLY if the new Recipe's effective_from actually overlaps its window —
   * enforces "only one active Recipe per SKU" while still letting a future-
   * dated recipe change wait to kick in without prematurely killing the
   * one it hasn't yet superseded. A Recipe's own effective_from is always
   * <= today by definition of being active, so only the upper bound
   * (effective_till) needs checking against the new Recipe's effective_from.
   * Marks the superseded formulation as retired rather than merely
   * inactive, and stamps its effective_till to today (the date it's being
   * superseded). Parameters: [sku_id, keep_bom_id, new_effective_from]
   */
  discontinueOverlappingActiveBomsForSku: `
    UPDATE master_recipe
    SET status = 'discontinued', effective_till = ${SQL_TODAY_IST}, updated_at = NOW()
    WHERE sku_id = ? AND id <> ? AND status = 'active'
      AND (effective_till IS NULL OR effective_till >= ?)
  `,

  /**
   * SKUs with more than one Recipe still "live" (producible) right now — this is
   * a fast-moving system where effective_till is often left unset, so both an
   * `active` Recipe and a `discontinued` one it superseded can remain producible
   * during a transition period until someone manually flips the older one to
   * `inactive`. Effective_till is intentionally ignored (unreliable); a Recipe
   * counts as live purely by status IN ('active','discontinued') AND
   * effective_from <= today. No params.
   */
  selectSkusWithMultipleLiveBoms: `
    SELECT
      sku_id,
      COUNT(*) AS live_bom_count,
      GROUP_CONCAT(id ORDER BY effective_from ASC, id ASC) AS bom_ids,
      GROUP_CONCAT(bom_code ORDER BY effective_from ASC, id ASC SEPARATOR ', ') AS bom_codes
    FROM master_recipe
    WHERE status IN ('active', 'discontinued') AND effective_from <= ${SQL_TODAY_IST} AND sku_id IS NOT NULL
    GROUP BY sku_id
    HAVING COUNT(*) > 1
  `,

  /** Same as selectSkusWithMultipleLiveBoms, restricted to Recipes this manufacturer produces. Params: [mfg_id] */
  selectSkusWithMultipleLiveBomsByMfg: `
    SELECT
      b.sku_id, sk.sku_code,
      COUNT(*) AS live_bom_count,
      GROUP_CONCAT(b.id ORDER BY b.effective_from ASC, b.id ASC) AS bom_ids,
      GROUP_CONCAT(b.bom_code ORDER BY b.effective_from ASC, b.id ASC SEPARATOR ', ') AS bom_codes
    FROM master_recipe b
    INNER JOIN master_recipe_mfg mbm ON mbm.recipe_id = b.id AND mbm.mfg_id = ?
    LEFT JOIN master_skus sk ON sk.id = b.sku_id
    WHERE b.status IN ('active', 'discontinued') AND b.effective_from <= ${SQL_TODAY_IST} AND b.sku_id IS NOT NULL
    GROUP BY b.sku_id, sk.sku_code
    HAVING COUNT(*) > 1
  `,

  // ============ ARCHIVE QUERIES (read-only "Recipe Archive" page) ============
  // history_recipe gets rows written by bomHandler.applyAndArchive (see
  // lib/approvals/module-handlers.ts) at approval time for EVERY approved Recipe
  // version (new-version and the legacy update-existing in-place edit alike)
  // — a Recipe with no history_recipe rows has never been through an approval yet.
  // The archive is scoped to status = 'inactive' ONLY — fully retired
  // versions. A 'discontinued' Recipe (superseded by a newer version, per
  // discontinueOverlappingActiveBomsForSku) is still considered "live" per
  // selectSkusWithMultipleLiveBoms's own comment, so it deliberately does NOT
  // show here until someone manually flips it to inactive via update-status.
  // Grouped SKU-wise: every version of a SKU's Recipe sorts together, oldest
  // first, so the full edit lineage reads top-to-bottom per SKU.

  /**
   * Paginated listing, one row per Recipe version (header) that has at least one
   * archived line, WITH the creating/approving user's name resolved — mirrors
   * selectPaginatedGrouped's shape (RecipeListItem-compatible) plus the audit
   * columns RecipeHistoryTable needs. Params: [like, like, like, LIMIT, OFFSET]
   */
  selectHistoryPaginatedGrouped: `
    SELECT
      b.id AS recipe_id, b.bom_code, b.sku_id, s.sku_code, s.name AS sku_name,
      b.status AS status,
      b.created_at, b.created_by, MAX(cu.name) AS created_by_name,
      b.updated_at, b.updated_by, MAX(uu.name) AS updated_by_name,
      MAX(h.approved_by) AS approved_by, MAX(au.name) AS approved_by_name,
      MAX(h.approved_on) AS approved_on,
      MAX(${CHANGE_REASON_SUBQUERY}) AS change_reason,
      MAX(${CHANGE_TYPE_SUBQUERY}) AS change_type
    FROM history_recipe AS h
    INNER JOIN master_recipe AS b ON b.id = h.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users uu ON uu.id = b.updated_by
    LEFT JOIN users au ON au.id = h.approved_by
    WHERE b.status = 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
    GROUP BY b.id, b.bom_code, b.sku_id, s.sku_code, s.name, b.status,
             b.created_at, b.created_by, b.updated_at, b.updated_by
    ORDER BY s.sku_code ASC, b.created_at ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching Recipe history rows, grouped (no LIMIT/OFFSET) — feeds
   * the fuzzy-search ranking path (lib/fuzzy-search.ts) when a search term is
   * present. Same shape/WHERE as selectHistoryPaginatedGrouped.
   * Params: [like, like, like]
   */
  selectAllFilteredHistoryGrouped: `
    SELECT
      b.id AS recipe_id, b.bom_code, b.sku_id, s.sku_code, s.name AS sku_name,
      b.status AS status,
      b.created_at, b.created_by, MAX(cu.name) AS created_by_name,
      b.updated_at, b.updated_by, MAX(uu.name) AS updated_by_name,
      MAX(h.approved_by) AS approved_by, MAX(au.name) AS approved_by_name,
      MAX(h.approved_on) AS approved_on,
      MAX(${CHANGE_REASON_SUBQUERY}) AS change_reason,
      MAX(${CHANGE_TYPE_SUBQUERY}) AS change_type
    FROM history_recipe AS h
    INNER JOIN master_recipe AS b ON b.id = h.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users uu ON uu.id = b.updated_by
    LEFT JOIN users au ON au.id = h.approved_by
    WHERE b.status = 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
    GROUP BY b.id, b.bom_code, b.sku_id, s.sku_code, s.name, b.status,
             b.created_at, b.created_by, b.updated_at, b.updated_by
    ORDER BY s.sku_code ASC, b.created_at ASC
  `,

  /** Matching COUNT for selectHistoryPaginatedGrouped. Params: [like, like, like] */
  countHistoryGrouped: `
    SELECT COUNT(DISTINCT b.id) AS total
    FROM history_recipe AS h
    INNER JOIN master_recipe AS b ON b.id = h.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status = 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
  `,

  // ============ ARTIFACT QUERIES (artifacts_recipe) ============
  // Reference files (spec sheets, lab reports, etc.) attached to a Recipe.
  // Rows are only ever written/deleted at approval time by
  // bomHandler.applyAndArchive (lib/approvals/module-handlers.ts) — add/remove
  // is staged client-side and submitted bundled with the RM/PM line diff via
  // create-full, same as the lines themselves never being written pre-approval.

  /**
   * All artifacts attached to a Recipe, oldest first. Params: [recipe_id]
   */
  selectArtifactsByBomId: `
    SELECT id, recipe_id, s3_key, file_name, uploaded_by, uploaded_at
    FROM artifacts_recipe
    WHERE recipe_id = ?
    ORDER BY uploaded_at ASC
  `,

  /**
   * Look up artifacts by id, SCOPED to a specific recipe_id so an approval can
   * never remove another Recipe's file. Used before deleteArtifactsByIds to
   * know which s3_key(s) to also delete from S3.
   * Params: [recipe_id, ids[]]
   */
  selectArtifactsByIds: `
    SELECT id, s3_key, file_name
    FROM artifacts_recipe
    WHERE recipe_id = ? AND id IN (?)
  `,

  /**
   * Parameters: [recipe_id, s3_key, file_name, uploaded_by]
   */
  insertArtifact: `
    INSERT INTO artifacts_recipe (recipe_id, s3_key, file_name, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, NOW())
  `,

  /**
   * Parameters: [recipe_id, ids[]]
   */
  deleteArtifactsByIds: `
    DELETE FROM artifacts_recipe WHERE recipe_id = ? AND id IN (?)
  `,

  /**
   * All archived lines for one Recipe, newest snapshot first — the History
   * page's detail-panel equivalent of selectDetailLinesByBomId. Params: [recipe_id]
   */
  selectHistoryLinesByBomId: `
    SELECT
      b.bom_code, h.recipe_id, s.sku_code,
      h.mtrl_id, h.mtrl_type, h.uom, h.amount,
      h.mtrl_cost, h.status AS material_status, b.status AS bom_status,
      h.last_updated,
      b.created_by,
      COALESCE(rm.name, pm.name) AS mtrl_name,
      COALESCE(rm.rm_code, pm.pm_code) AS mtrl_code,
      COALESCE(rm.status, pm.status) AS mtrl_master_status
    FROM history_recipe AS h
    INNER JOIN master_recipe AS b ON b.id = h.recipe_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN master_rm AS rm ON rm.id = h.mtrl_id AND h.mtrl_type = 'rm'
    LEFT JOIN master_pm AS pm ON pm.id = h.mtrl_id AND h.mtrl_type = 'pm'
    WHERE h.recipe_id = ?
    ORDER BY h.last_updated DESC, h.mtrl_type ASC, h.mtrl_id ASC
  `,
  /** The brand behind a recipe, for the write-side brand guard. Reached through
   *  master_recipe.sku_id, which is nullable — a recipe with no SKU resolves to
   *  no brand and the guard treats that as unattributed.
   *  Parameters: [recipe_id] */
  selectBrandIdByRecipeId: `
    SELECT s.brand_id
    FROM master_recipe b
    LEFT JOIN master_skus s ON s.id = b.sku_id
    WHERE b.id = ? LIMIT 1
  `,

}
