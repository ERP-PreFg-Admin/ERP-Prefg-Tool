/**
 * BOM Queries
 * Centralized queries for master_bom, details_bom, and history_bom.
 *
 * Real schema (verify against prisma/schema.prisma before adding queries —
 * master_bom has NO sku_code/mfg_id columns, only sku_id):
 *   master_bom(id, bom_code, sku_id, status, created_by, created_at, updated_by,
 *              updated_at, effective_from, effective_till)
 *   details_bom(id, bom_id → master_bom.id, mtrl_type, mtrl_id, amount, uom,
 *               effective_from, effective_till, status, updated_by, last_updated)
 *   history_bom — same shape as details_bom plus mtrl_cost; snapshot target for
 *               "update existing BOM in place" (see lib/approvals/module-handlers.ts)
 *
 * effective_from/effective_till live on the BOM HEADER (master_bom), one pair
 * per recipe — not per RM/PM line. effective_from is entered by the user when
 * the BOM is created/edited; effective_till is set automatically (to the
 * approval date) when a BOM is discontinued/superseded by a new version. The
 * same two columns still exist on details_bom/history_bom for legacy rows
 * (pre-dating this change) and are what the read-only BOM History page still
 * shows — new lines no longer populate them.
 *
 * IMPORTANT: master_bom_status's "in_review" enum member is @map("in review")
 * in prisma/schema.prisma — the ACTUAL value stored in the DB column has a
 * space, unlike every other module's status column (STATUS.IN_REVIEW =
 * "in_review", no space). Never write STATUS.IN_REVIEW to master_bom.status —
 * use BOM_STATUS_IN_REVIEW below, or the write silently fails/rolls back.
 */

export const BOM_STATUS_IN_REVIEW = "in review"

export const bom = {
  // ============ SELECT QUERIES ============

  /**
   * Get all BOM records with detail lines joined.
   * Returns full columns from both bom and bom_details.
   */
  selectAll: `
    SELECT
      b.bom_code, bd.bom_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_bom AS bd
    INNER JOIN master_bom AS b ON b.id = bd.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    ORDER BY b.bom_code ASC
  `,

  // ============ PAGINATED SELECT QUERIES ============

  /**
   * Paginated BOM list with optional search, material-type, and status filters.
   * Params: [like, like, like, type, type, status, status, LIMIT, OFFSET]
   *   like   — '%search%' or null (bom_code / sku_code columns)
   *   type   — 'rm'|'pm' or null
   *   status — 'draft'|'active'|'inactive' or null
   */
  selectPaginated: `
    SELECT
      b.bom_code, bd.bom_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_bom AS bd
    INNER JOIN master_bom AS b ON b.id = bd.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching BOM rows for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated.
   * Params: [like, like, like, type, type, status, status]
   */
  selectAllFiltered: `
    SELECT
      b.bom_code, bd.bom_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      b.effective_from, b.effective_till, bd.last_updated,
      b.created_by
    FROM details_bom AS bd
    INNER JOIN master_bom AS b ON b.id = bd.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
  `,

  /**
   * Matching COUNT for selectPaginated.
   * Params: [like, like, like, type, type, status, status]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM details_bom AS bd
    INNER JOIN master_bom AS b ON b.id = bd.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR bd.mtrl_type = ?)
      AND (? IS NULL OR b.status = ?)
  `,

  /**
   * Does this SKU already have an ACTIVE BOM? Params: [sku_id]
   */
  selectActiveBomBySkuId: `
    SELECT b.id AS bom_id, b.bom_code, b.status
    FROM master_bom AS b
    WHERE b.sku_id = ? AND b.status = 'active'
    LIMIT 1
  `,

  /**
   * All BOMs (any status) for a SKU, newest first — used to suggest the next
   * version's bom_code. Params: [sku_id]
   */
  selectBomsBySkuId: `
    SELECT id AS bom_id, bom_code, status, created_at
    FROM master_bom
    WHERE sku_id = ?
    ORDER BY created_at DESC
  `,

  /**
   * The single most recent BOM for a SKU (any status — the prior BOM to diff
   * a new version against may be `discontinued` per the "2 BOMs live"
   * definition, so an active-only query would miss it), with its rm/pm
   * version numbers for independent-version bom_code generation. Params: [sku_id]
   */
  selectMostRecentBomForSku: `
    SELECT id, bom_code, rm_version, pm_version
    FROM master_bom
    WHERE sku_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `,

  /**
   * Every active SKU whose active BOM references this material — portfolio-wide,
   * used by the RM/PM vendor-rate edit dialogs' cost-impact alert.
   * Params: [mtrl_type, mtrl_id]
   */
  selectActiveSkusUsingMaterial: `
    SELECT DISTINCT s.sku_code, s.name
    FROM details_bom bd
    INNER JOIN master_bom b ON b.id = bd.bom_id AND b.status = 'active'
    INNER JOIN master_skus s ON s.id = b.sku_id
    WHERE bd.mtrl_type = ? AND bd.mtrl_id = ? AND bd.status = 'active'
    ORDER BY s.sku_code ASC
  `,

  /**
   * Same as selectActiveSkusUsingMaterial, but narrowed to SKUs one specific
   * manufacturer actually produces (via master_bom_mfg) — used by the RM/PM
   * manufacturer-rate edit dialogs' cost-impact alert.
   * Params: [mfg_id, mtrl_type, mtrl_id]
   */
  selectActiveSkusUsingMaterialForMfg: `
    SELECT DISTINCT s.sku_code, s.name
    FROM details_bom bd
    INNER JOIN master_bom b ON b.id = bd.bom_id AND b.status = 'active'
    INNER JOIN master_bom_mfg mbm ON mbm.bom_id = b.id AND mbm.status = 'active' AND mbm.mfg_id = ?
    INNER JOIN master_skus s ON s.id = b.sku_id
    WHERE bd.mtrl_type = ? AND bd.mtrl_id = ? AND bd.status = 'active'
    ORDER BY s.sku_code ASC
  `,

  /**
   * Bare header lookup for existence/status checks before mutating. Params: [id]
   */
  selectBomHeaderRawById: `
    SELECT id, bom_code, sku_id, status, created_by
    FROM master_bom
    WHERE id = ?
  `,

  /**
   * Bulk bom_code + status lookup by id — resolves master_skus.active_bom_id
   * to a display code for a whole page of SKU rows in one query. Params: [ids[]]
   */
  selectBomCodesByIds: `
    SELECT id, bom_code, status
    FROM master_bom
    WHERE id IN (?)
  `,

  /**
   * All current detail lines for a BOM, raw columns (no name/code joins) —
   * used to snapshot into history_bom and to diff against a proposed line set.
   * Params: [bom_id]
   */
  selectDetailLinesRawByBomId: `
    SELECT id, bom_id, mtrl_type, mtrl_id, amount, uom, effective_from, effective_till, status, updated_by
    FROM details_bom
    WHERE bom_id = ?
    ORDER BY mtrl_type ASC, mtrl_id ASC
  `,

  /**
   * Paginated BOM listing, ONE ROW PER BOM HEADER (not per material line).
   * effective_from/effective_till are the BOM header's own columns (recipe-
   * level, not aggregated from lines). Params: [like, like, like, status, status, LIMIT, OFFSET]
   */
  selectPaginatedGrouped: `
    SELECT
      b.id AS bom_id, b.bom_code, s.sku_code, s.name AS sku_name,
      b.created_at, b.effective_from, b.effective_till,
      b.status AS status
    FROM master_bom AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching BOM headers (no LIMIT/OFFSET) — feeds the fuzzy-search
   * ranking path (lib/fuzzy-search.ts) when a search term is present. Same
   * shape/WHERE as selectPaginatedGrouped.
   * Params: [like, like, like, status, status]
   */
  selectAllFilteredGrouped: `
    SELECT
      b.id AS bom_id, b.bom_code, s.sku_code, s.name AS sku_name,
      b.created_at, b.effective_from, b.effective_till,
      b.status AS status
    FROM master_bom AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR b.status = ?)
    ORDER BY b.bom_code ASC
  `,

  /**
   * Matching COUNT for selectPaginatedGrouped (one BOM header = one row).
   * Params: [like, like, like, status, status]
   */
  countGrouped: `
    SELECT COUNT(*) AS total
    FROM master_bom AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.status <> 'inactive'
      AND (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
      AND (? IS NULL OR b.status = ?)
  `,

  /**
   * BOM header for the detail side-panel. Params: [bom_id]
   */
  selectHeaderById: `
    SELECT b.id AS bom_id, b.bom_code, b.sku_id, s.sku_code, b.status, b.created_at,
      b.effective_from, b.effective_till
    FROM master_bom AS b
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE b.id = ?
  `,

  /**
   * All material lines for a BOM, for the detail side-panel. Params: [bom_id]
   * Resolves the material's name/code from master_rm or master_pm depending
   * on mtrl_type, since details_bom only stores a bare mtrl_id.
   */
  selectDetailLinesByBomId: `
    SELECT
      b.bom_code, bd.bom_id, s.sku_code,
      bd.mtrl_id, bd.mtrl_type, bd.uom, bd.amount,
      NULL AS mtrl_cost, bd.status AS material_status, b.status AS bom_status,
      bd.effective_from, bd.effective_till, bd.last_updated,
      b.created_by,
      COALESCE(rm.name, pm.name) AS mtrl_name,
      COALESCE(rm.rm_code, pm.pm_code) AS mtrl_code,
      COALESCE(rm.status, pm.status) AS mtrl_master_status
    FROM details_bom AS bd
    INNER JOIN master_bom AS b ON b.id = bd.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN master_rm AS rm ON rm.id = bd.mtrl_id AND bd.mtrl_type = 'rm'
    LEFT JOIN master_pm AS pm ON pm.id = bd.mtrl_id AND bd.mtrl_type = 'pm'
    WHERE bd.bom_id = ?
    ORDER BY bd.mtrl_type ASC, bd.mtrl_id ASC
  `,

  // ============ WRITE QUERIES ============

  /**
   * Insert a new BOM header. Parameters: [bom_code, sku_id, created_by, status, effective_from]
   * Returns insertId to link detail lines to.
   */
  insertBomHeader: `
    INSERT INTO master_bom (bom_code, sku_id, created_by, status, effective_from, created_at)
    VALUES (?, ?, ?, ?, ?, NOW())
  `,

  /**
   * Same as insertBomHeader, but also stamps rm_version/pm_version — used
   * only by the single-BOM new-version submit path (app/api/masters/bom-master/route.ts),
   * which computes these independently via lib/masters/bom-version.ts's
   * diffBomLines. The CSV bulk-upload path (lib/approvals/handlers/bom.ts)
   * keeps using plain insertBomHeader and the legacy bom_code format.
   */
  insertBomHeaderWithVersions: `
    INSERT INTO master_bom (bom_code, sku_id, created_by, status, effective_from, rm_version, pm_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `,

  /**
   * Insert a single BOM detail line. Only ever called at approval time (see
   * lib/approvals/module-handlers.ts bomHandler) — never at submission time.
   * effective_from/effective_till are recipe-level (master_bom), not per line —
   * this table's own columns of the same name are left NULL for new lines and
   * only remain populated on legacy/history rows.
   * Parameters: [bom_id, mtrl_type, mtrl_id, amount, uom, status, updated_by]
   */
  insertDetailLine: `
    INSERT INTO details_bom
      (bom_id, mtrl_type, mtrl_id, amount, uom, status, updated_by, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `,

  /**
   * Archive one detail line snapshot into history_bom — written at approval
   * time for EVERY approved BOM version (both "new-version" and the legacy
   * "update-existing" in-place edit), so the History page has a full
   * line-level record of every edit, per SKU, regardless of mode.
   * updated_by is the user who SUBMITTED this edit; approved_by/approved_on
   * are the user/time it was approved (same transaction as the approval).
   * Parameters: [bom_id, mtrl_type, mtrl_id, amount, uom, mtrl_cost, effective_from, effective_till, status, updated_by, approved_by]
   */
  archiveDetailLineToHistory: `
    INSERT INTO history_bom
      (bom_id, mtrl_type, mtrl_id, amount, uom, mtrl_cost, effective_from, effective_till, status, updated_by, last_updated, approved_by, approved_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
  `,

  /**
   * Delete all current detail lines for a BOM before re-inserting the new
   * set — used by the "update existing in place" apply step, AFTER archiving.
   * Parameters: [bom_id]
   */
  deleteDetailLinesByBomId: `
    DELETE FROM details_bom WHERE bom_id = ?
  `,

  /** Parameters: [status, bom_id] */
  setBomStatus: `
    UPDATE master_bom SET status = ?, updated_at = NOW() WHERE id = ?
  `,

  /** Parameters: [status, updated_by, bom_id] */
  setBomStatusWithUpdater: `
    UPDATE master_bom SET status = ?, updated_by = ?, updated_at = NOW() WHERE id = ?
  `,

  /**
   * IDs of every OTHER active BOM for the same sku_id, read BEFORE
   * deactivateOtherActiveBomsForSku runs — MariaDB's UPDATE has no RETURNING,
   * so this is how the caller knows which BOMs it's about to deactivate (one
   * bom.deactivated event per id, per event-catalog.md's fan-out design).
   * Parameters: [sku_id, keep_bom_id]
   */
  selectOtherActiveBomsForSku: `
    SELECT id
    FROM master_bom
    WHERE sku_id = ? AND id <> ? AND status = 'active'
  `,

  /**
   * Flip every OTHER active BOM for the same sku_id to discontinued —
   * enforces "only one active BOM per SKU" after a new/updated BOM is
   * activated, marks the superseded formulation as retired rather than
   * merely inactive, and stamps its effective_till to today (the date it's
   * being superseded). Parameters: [sku_id, keep_bom_id]
   */
  discontinueOtherActiveBomsForSku: `
    UPDATE master_bom
    SET status = 'discontinued', effective_till = CURDATE(), updated_at = NOW()
    WHERE sku_id = ? AND id <> ? AND status = 'active'
  `,

  /**
   * SKUs with more than one BOM still "live" (producible) right now — this is
   * a fast-moving system where effective_till is often left unset, so both an
   * `active` BOM and a `discontinued` one it superseded can remain producible
   * during a transition period until someone manually flips the older one to
   * `inactive`. Effective_till is intentionally ignored (unreliable); a BOM
   * counts as live purely by status IN ('active','discontinued') AND
   * effective_from <= today. No params.
   */
  selectSkusWithMultipleLiveBoms: `
    SELECT
      sku_id,
      COUNT(*) AS live_bom_count,
      GROUP_CONCAT(id ORDER BY effective_from ASC, id ASC) AS bom_ids,
      GROUP_CONCAT(bom_code ORDER BY effective_from ASC, id ASC SEPARATOR ', ') AS bom_codes
    FROM master_bom
    WHERE status IN ('active', 'discontinued') AND effective_from <= CURDATE() AND sku_id IS NOT NULL
    GROUP BY sku_id
    HAVING COUNT(*) > 1
  `,

  /** Same as selectSkusWithMultipleLiveBoms, restricted to BOMs this manufacturer produces. Params: [mfg_id] */
  selectSkusWithMultipleLiveBomsByMfg: `
    SELECT
      b.sku_id, sk.sku_code,
      COUNT(*) AS live_bom_count,
      GROUP_CONCAT(b.id ORDER BY b.effective_from ASC, b.id ASC) AS bom_ids,
      GROUP_CONCAT(b.bom_code ORDER BY b.effective_from ASC, b.id ASC SEPARATOR ', ') AS bom_codes
    FROM master_bom b
    INNER JOIN master_bom_mfg mbm ON mbm.bom_id = b.id AND mbm.mfg_id = ?
    LEFT JOIN master_skus sk ON sk.id = b.sku_id
    WHERE b.status IN ('active', 'discontinued') AND b.effective_from <= CURDATE() AND b.sku_id IS NOT NULL
    GROUP BY b.sku_id, sk.sku_code
    HAVING COUNT(*) > 1
  `,

  // ============ HISTORY QUERIES (read-only "BOM History" page) ============
  // history_bom gets rows written by bomHandler.applyAndArchive (see
  // lib/approvals/module-handlers.ts) at approval time for EVERY approved BOM
  // version (new-version and the legacy update-existing in-place edit alike)
  // — a BOM with no history_bom rows has never been through an approval yet.
  // Grouped SKU-wise: every version of a SKU's BOM sorts together, oldest
  // first, so the full edit lineage reads top-to-bottom per SKU.

  /**
   * Paginated listing, one row per BOM version (header) that has at least one
   * archived line, WITH the creating/approving user's name resolved — mirrors
   * selectPaginatedGrouped's shape (BomListItem-compatible) plus the audit
   * columns BomHistoryTable needs. Params: [like, like, like, LIMIT, OFFSET]
   */
  selectHistoryPaginatedGrouped: `
    SELECT
      b.id AS bom_id, b.bom_code, b.sku_id, s.sku_code, s.name AS sku_name,
      b.status AS status,
      b.created_at, b.created_by, MAX(cu.name) AS created_by_name,
      b.updated_at, b.updated_by, MAX(uu.name) AS updated_by_name,
      MAX(h.approved_by) AS approved_by, MAX(au.name) AS approved_by_name,
      MAX(h.approved_on) AS approved_on
    FROM history_bom AS h
    INNER JOIN master_bom AS b ON b.id = h.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users uu ON uu.id = b.updated_by
    LEFT JOIN users au ON au.id = h.approved_by
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
    GROUP BY b.id, b.bom_code, b.sku_id, s.sku_code, s.name, b.status,
             b.created_at, b.created_by, b.updated_at, b.updated_by
    ORDER BY s.sku_code ASC, b.created_at ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching BOM history rows, grouped (no LIMIT/OFFSET) — feeds
   * the fuzzy-search ranking path (lib/fuzzy-search.ts) when a search term is
   * present. Same shape/WHERE as selectHistoryPaginatedGrouped.
   * Params: [like, like, like]
   */
  selectAllFilteredHistoryGrouped: `
    SELECT
      b.id AS bom_id, b.bom_code, b.sku_id, s.sku_code, s.name AS sku_name,
      b.status AS status,
      b.created_at, b.created_by, MAX(cu.name) AS created_by_name,
      b.updated_at, b.updated_by, MAX(uu.name) AS updated_by_name,
      MAX(h.approved_by) AS approved_by, MAX(au.name) AS approved_by_name,
      MAX(h.approved_on) AS approved_on
    FROM history_bom AS h
    INNER JOIN master_bom AS b ON b.id = h.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users uu ON uu.id = b.updated_by
    LEFT JOIN users au ON au.id = h.approved_by
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
    GROUP BY b.id, b.bom_code, b.sku_id, s.sku_code, s.name, b.status,
             b.created_at, b.created_by, b.updated_at, b.updated_by
    ORDER BY s.sku_code ASC, b.created_at ASC
  `,

  /** Matching COUNT for selectHistoryPaginatedGrouped. Params: [like, like, like] */
  countHistoryGrouped: `
    SELECT COUNT(DISTINCT b.id) AS total
    FROM history_bom AS h
    INNER JOIN master_bom AS b ON b.id = h.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    WHERE (? IS NULL OR b.bom_code LIKE ? OR s.sku_code LIKE ?)
  `,

  // ============ ARTIFACT QUERIES (bom_artifacts) ============
  // Reference files (spec sheets, lab reports, etc.) attached to a BOM.
  // Rows are only ever written/deleted at approval time by
  // bomHandler.applyAndArchive (lib/approvals/module-handlers.ts) — add/remove
  // is staged client-side and submitted bundled with the RM/PM line diff via
  // create-full, same as the lines themselves never being written pre-approval.

  /**
   * All artifacts attached to a BOM, oldest first. Params: [bom_id]
   */
  selectArtifactsByBomId: `
    SELECT id, bom_id, s3_key, file_name, uploaded_by, uploaded_at
    FROM bom_artifacts
    WHERE bom_id = ?
    ORDER BY uploaded_at ASC
  `,

  /**
   * Look up artifacts by id, SCOPED to a specific bom_id so an approval can
   * never remove another BOM's file. Used before deleteArtifactsByIds to
   * know which s3_key(s) to also delete from S3.
   * Params: [bom_id, ids[]]
   */
  selectArtifactsByIds: `
    SELECT id, s3_key, file_name
    FROM bom_artifacts
    WHERE bom_id = ? AND id IN (?)
  `,

  /**
   * Parameters: [bom_id, s3_key, file_name, uploaded_by]
   */
  insertArtifact: `
    INSERT INTO bom_artifacts (bom_id, s3_key, file_name, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, NOW())
  `,

  /**
   * Parameters: [bom_id, ids[]]
   */
  deleteArtifactsByIds: `
    DELETE FROM bom_artifacts WHERE bom_id = ? AND id IN (?)
  `,

  /**
   * All archived lines for one BOM, newest snapshot first — the History
   * page's detail-panel equivalent of selectDetailLinesByBomId. Params: [bom_id]
   */
  selectHistoryLinesByBomId: `
    SELECT
      b.bom_code, h.bom_id, s.sku_code,
      h.mtrl_id, h.mtrl_type, h.uom, h.amount,
      h.mtrl_cost, h.status AS material_status, b.status AS bom_status,
      h.effective_from, h.effective_till, h.last_updated,
      b.created_by,
      COALESCE(rm.name, pm.name) AS mtrl_name,
      COALESCE(rm.rm_code, pm.pm_code) AS mtrl_code,
      COALESCE(rm.status, pm.status) AS mtrl_master_status
    FROM history_bom AS h
    INNER JOIN master_bom AS b ON b.id = h.bom_id
    LEFT JOIN master_skus AS s ON s.id = b.sku_id
    LEFT JOIN master_rm AS rm ON rm.id = h.mtrl_id AND h.mtrl_type = 'rm'
    LEFT JOIN master_pm AS pm ON pm.id = h.mtrl_id AND h.mtrl_type = 'pm'
    WHERE h.bom_id = ?
    ORDER BY h.last_updated DESC, h.mtrl_type ASC, h.mtrl_id ASC
  `,
}
