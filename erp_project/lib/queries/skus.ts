/**
 * SKU Queries
 *
 * Centralised queries for the `master_skus` table. Edit-history/audit trail
 * lives in the generic `history_masters_edits` table (module="SKU") —
 * see lib/queries/history.ts and lib/master-routes/history-utils.ts — not a
 * per-module `sku_history` table.
 */

/**
 * Full display column list for `master_skus`, excluding `base_sku_sno` (used
 * only by the brand+sno grouping query below) and history-only concerns.
 * Every column is table-qualified because selectPaginated/selectAllFiltered
 * LEFT JOIN a `vg` derived table that also has a `brand` column — an
 * unqualified `brand` there is ambiguous (ER_NON_UNIQ_ERROR).
 */
const SKU_COLUMNS = `
  master_skus.id, master_skus.sku_code, master_skus.name, master_skus.brand,
  master_skus.sku_type, master_skus.category, master_skus.subcategory,
  master_skus.filling, master_skus.filling_uom, master_skus.mrp, master_skus.gst,
  master_skus.active_bom_id, master_skus.status,
  master_skus.created_at, master_skus.created_by, master_skus.updated_by, master_skus.updated_on
`

export const skus = {
  // ============ SELECT QUERIES ============

  /** Get all SKUs — used by CSV / Add wizards that need the full list. */
  selectAll: `
    SELECT ${SKU_COLUMNS}
    FROM master_skus
    ORDER BY sku_code ASC
  `,

  /** Active SKUs only — used to populate the Recipe wizard's SKU picker. */
  selectActive: `
    SELECT ${SKU_COLUMNS}
    FROM master_skus
    WHERE status = 'active'
    ORDER BY sku_code ASC
  `,

  /**
   * Fetch a single SKU by id (used before update to snapshot for history).
   * Parameters: [id]
   */
  selectById: `
    SELECT ${SKU_COLUMNS}
    FROM master_skus WHERE id = ? LIMIT 1
  `,
  /**
   * Fetch a single SKU by sku_code (used before update to snapshot for history).
   * Parameters: [sku_code]
   */
  selectByCode: ` SELECT id, sku_code, status FROM master_skus WHERE sku_code = ? LIMIT 1
  `,

  // ============ PAGINATED SELECT QUERIES ============

  /**
   * Paginated SKU list with optional search + status + brand + sku_type +
   * category + subcategory + missing-Recipe filters. Also joins a `variant_count`
   * column (SKUs sharing this row's brand + base_sku_sno) so the client can
   * decide, per row, whether the "see variants" row action should be shown
   * (variant_count > 1).
   * Params: [like×4, brandScope×2, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom, LIMIT, OFFSET]
   * brandScope is scopeParams(scope.brandIds) — the access boundary, keyed on
   * brand_id. Distinct from the `brand` filter two slots later, which is the
   * user's dropdown choice keyed on the free-text column.
   */
  selectPaginated: `
    SELECT ${SKU_COLUMNS}, master_skus.base_sku_sno, COALESCE(vg.variant_count, 1) AS variant_count
    FROM master_skus
    LEFT JOIN (
      SELECT brand, base_sku_sno, COUNT(*) AS variant_count
      FROM master_skus
      WHERE base_sku_sno IS NOT NULL
      GROUP BY brand, base_sku_sno
    ) vg ON vg.brand = master_skus.brand AND vg.base_sku_sno = master_skus.base_sku_sno
    WHERE (? IS NULL OR master_skus.sku_code LIKE ? OR master_skus.name LIKE ? OR master_skus.brand LIKE ?)
      -- Boundary FIRST, immediately after the search block, in all three of
      -- selectPaginated / selectAllFiltered / countAll. They share one param
      -- array, so a predicate moved in one query and not the others silently
      -- binds every later value to the wrong column — arity still matches, so
      -- nothing errors.
      AND (? IS NULL OR master_skus.brand_id IS NULL OR master_skus.brand_id IN (?))
      AND (? IS NULL OR master_skus.status = ?)
      AND (? IS NULL OR master_skus.brand = ?)
      AND (? IS NULL OR master_skus.sku_type = ?)
      AND (? IS NULL OR master_skus.category = ?)
      AND (? IS NULL OR master_skus.subcategory = ?)
      AND (? IS NULL OR master_skus.active_bom_id IS NULL)
    ORDER BY master_skus.sku_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching SKUs for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated; call countAll first to enforce the
   * row cap before running this.
   * Params: [like×4, brandScope×2, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom]
   */
  selectAllFiltered: `
    SELECT ${SKU_COLUMNS}, master_skus.base_sku_sno, COALESCE(vg.variant_count, 1) AS variant_count
    FROM master_skus
    LEFT JOIN (
      SELECT brand, base_sku_sno, COUNT(*) AS variant_count
      FROM master_skus
      WHERE base_sku_sno IS NOT NULL
      GROUP BY brand, base_sku_sno
    ) vg ON vg.brand = master_skus.brand AND vg.base_sku_sno = master_skus.base_sku_sno
    WHERE (? IS NULL OR master_skus.sku_code LIKE ? OR master_skus.name LIKE ? OR master_skus.brand LIKE ?)
      -- Boundary FIRST, immediately after the search block, in all three of
      -- selectPaginated / selectAllFiltered / countAll. They share one param
      -- array, so a predicate moved in one query and not the others silently
      -- binds every later value to the wrong column — arity still matches, so
      -- nothing errors.
      AND (? IS NULL OR master_skus.brand_id IS NULL OR master_skus.brand_id IN (?))
      AND (? IS NULL OR master_skus.status = ?)
      AND (? IS NULL OR master_skus.brand = ?)
      AND (? IS NULL OR master_skus.sku_type = ?)
      AND (? IS NULL OR master_skus.category = ?)
      AND (? IS NULL OR master_skus.subcategory = ?)
      AND (? IS NULL OR master_skus.active_bom_id IS NULL)
    ORDER BY master_skus.sku_code ASC
  `,

  // ============ GROUPING / VARIANT QUERIES ============

  /**
   * Groups SKUs that share the same brand + base_sku_sno (i.e. size/variant
   * families of the same base product). Only groups with more than one
   * member are returned; each group's SKUs are packed into JSON via
   * GROUP_CONCAT so a single row represents the whole family.
   * No params.
   */
  selectGroupedByBrandAndSno: `
    SELECT
      brand,
      base_sku_sno,
      COUNT(*) AS sku_count,
      GROUP_CONCAT(
        JSON_OBJECT(
          'id', id,
          'sku_code', sku_code,
          'name', name,
          'sku_type', sku_type,
          'category', category,
          'subcategory', subcategory,
          'filling', filling,
          'filling_uom', filling_uom,
          'mrp', mrp,
          'status', status
        )
      ) AS skus_json
    FROM master_skus
    WHERE brand IS NOT NULL AND base_sku_sno IS NOT NULL
    GROUP BY brand, base_sku_sno
    HAVING COUNT(*) > 1
    ORDER BY brand ASC, base_sku_sno ASC
  `,

  /**
   * Sibling SKUs sharing one SKU's brand + base_sku_sno — feeds the per-row
   * "variants" popup (simple row list, not the JSON-packed report above).
   * Params: [brand, base_sku_sno]
   */
  selectVariantsByBrandAndSno: `
    SELECT id, sku_code, name, sku_type, category, subcategory, filling, filling_uom, mrp, status,
      is_base_sku
    FROM master_skus
    WHERE brand = ? AND base_sku_sno = ?
    ORDER BY sku_code ASC
  `,

  /**
   * The whole variant family for ONE SKU id, with each member's active Recipe —
   * the input to resolveRmLock (lib/masters/variant-rm-lock.ts), which decides
   * whether that SKU's recipe may change RM and whose RM it inherits.
   *
   * Self-joins on the (brand, base_sku_sno) grouping key, so the result
   * INCLUDES the SKU asked about. A SKU with a NULL brand or base_sku_sno
   * returns ZERO rows — the grouping key doesn't exist for it, so it is in no
   * family, which resolveRmLock reads as "RM unlocked". That degenerate answer
   * is load-bearing: NULL = NULL is never true in SQL, so without the explicit
   * IS NOT NULL guards every unfamilied SKU would still self-match on id and
   * look like a one-member family (same answer, by luck rather than intent).
   *
   * Params: [sku_id]
   */
  selectVariantFamilyBySkuId: `
    SELECT
      v.id, v.sku_code, v.name, v.status, v.is_base_sku,
      v.brand, v.base_sku_sno,
      r.id AS active_recipe_id, r.bom_code, r.rm_version, r.created_at AS recipe_created_at
    FROM master_skus s
    INNER JOIN master_skus v
      ON v.brand = s.brand AND v.base_sku_sno = s.base_sku_sno
    LEFT JOIN master_recipe r
      ON r.sku_id = v.id AND r.status = 'active'
    WHERE s.id = ? AND s.brand IS NOT NULL AND s.base_sku_sno IS NOT NULL
    ORDER BY v.sku_code ASC
  `,

  /**
   * Why a SKU can't be costed yet — the same gaps the Agreed Final Costing tab
   * flags per manufacturer, rolled up per SKU for the master list.
   *
   * A line is counted as "without rate" when it lacks an active agreed rate for
   * at least one mapped manufacturer, so the count matches what someone would
   * see if they opened each of that SKU's manufacturers in turn. COUNT(DISTINCT
   * db.id) is load-bearing: the mfg join multiplies every line by the number of
   * manufacturers, and a plain SUM would report 8 RM lines as 24.
   *
   * With no manufacturer mapped, mbm.mfg_id is NULL and every rate join misses —
   * so mfg_count = 0 means the caller must report "not mapped" and ignore the
   * rate counts (see SkusClient.costingReasonsFor).
   *
   * Keyed on master_recipe.sku_id, NOT master_skus.active_bom_id: costing works
   * off whichever recipe is mapped to the manufacturer, so a SKU whose
   * active_bom_id is unset still gets costed — and would otherwise show a clean
   * row here while the costing tab flags it.
   * Params: [skuIds] — needs query(), not execute(), for IN (?) expansion.
   */
  selectCostingGapsBySkuIds: `
    SELECT b.sku_id AS sku_id,
      COUNT(DISTINCT mbm.mfg_id)                                                             AS mfg_count,
      COUNT(DISTINCT CASE WHEN db.mtrl_type = 'rm' THEN db.id END)                           AS rm_line_count,
      COUNT(DISTINCT CASE WHEN db.mtrl_type = 'pm' THEN db.id END)                           AS pm_line_count,
      COUNT(DISTINCT CASE WHEN db.mtrl_type = 'rm' AND rmm.curr_rate IS NULL THEN db.id END) AS rm_lines_without_rate,
      COUNT(DISTINCT CASE WHEN db.mtrl_type = 'pm' AND pmm.curr_rate IS NULL THEN db.id END) AS pm_lines_without_rate
    FROM master_recipe b
    LEFT JOIN details_recipe db ON db.recipe_id = b.id AND db.status = 'active'
    LEFT JOIN master_recipe_mfg mbm ON mbm.recipe_id = b.id AND mbm.status IN ('active', 'discontinued')
    LEFT JOIN cost_master_rm_mfg rmm ON rmm.rm_id = db.mtrl_id AND rmm.mfg_id = mbm.mfg_id AND rmm.status = 'active' AND db.mtrl_type = 'rm'
    LEFT JOIN cost_master_pm_mfg pmm ON pmm.pm_id = db.mtrl_id AND pmm.mfg_id = mbm.mfg_id AND pmm.status = 'active' AND db.mtrl_type = 'pm'
    WHERE b.sku_id IN (?) AND b.status IN ('active', 'discontinued')
    GROUP BY b.sku_id
  `,

  // ============ DISTINCT-VALUE LOOKUPS (filter dropdowns) ============

  selectDistinctBrands: `
    SELECT DISTINCT brand FROM master_skus WHERE brand IS NOT NULL AND brand <> '' ORDER BY brand ASC
  `,
  selectDistinctSkuTypes: `
    SELECT DISTINCT sku_type FROM master_skus WHERE sku_type IS NOT NULL AND sku_type <> '' ORDER BY sku_type ASC
  `,
  selectDistinctCategories: `
    SELECT DISTINCT category FROM master_skus WHERE category IS NOT NULL AND category <> '' ORDER BY category ASC
  `,
  selectDistinctSubcategories: `
    SELECT DISTINCT subcategory FROM master_skus WHERE subcategory IS NOT NULL AND subcategory <> '' ORDER BY subcategory ASC
  `,

  /**
   * Matching COUNT for selectPaginated.
   * Params: [like×4, brandScope×2, status×2, brand×2, sku_type×2, category×2, subcategory×2, missingBom]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM master_skus
    WHERE (? IS NULL OR sku_code LIKE ? OR name LIKE ? OR brand LIKE ?)
      AND (? IS NULL OR master_skus.brand_id IS NULL OR master_skus.brand_id IN (?))
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR brand = ?)
      AND (? IS NULL OR sku_type = ?)
      AND (? IS NULL OR category = ?)
      AND (? IS NULL OR subcategory = ?)
      AND (? IS NULL OR active_bom_id IS NULL)
  `,

  // ============ UPDATE QUERIES ============

  /**
   * Update editable SKU fields (sku_code is immutable).
   * Parameters: [name, brand, category, subcategory, sku_type, mrp, status, id]
   */
  /** Parameters: [name, brand, category, subcategory, sku_type, filling, filling_uom, mrp, status, id] */
  updateSku: `
    UPDATE master_skus
    SET name = ?, brand = ?, category = ?, subcategory = ?, sku_type = ?, filling = ?, filling_uom = ?, mrp = ?, status = ?
    WHERE id = ?
  `,

  // ============ INSERT QUERIES ============

  /** Insert a new SKU row.
   *  Parameters: [sku_code, name, brand, category, status, created_by]
   */
  insertSku: `
    INSERT INTO master_skus (sku_code, name, brand, category, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Set the status of a SKU (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setStatus: `UPDATE master_skus SET status = ? WHERE id = ?`,

  /**
   * Point a SKU at its currently-active Recipe — called whenever a Recipe
   * transitions TO 'active' (bomHandler.applyAndArchive on approval,
   * bomBulkHandler.applyAndArchive, and the update-status action), so
   * master_skus.active_bom_id never goes stale. This is what the SKU
   * master list's bom_code column resolves (see skus.selectPaginated's
   * active_bom_id -> app/masters/skus/page.tsx's selectBomCodesByIds join).
   * Parameters: [recipe_id, sku_id]
   */
  setActiveBomId: `UPDATE master_skus SET active_bom_id = ? WHERE id = ?`,

  /**
   * Clear a SKU's active_bom_id, but ONLY if it still points at the Recipe
   * being deactivated — guards against clobbering a newer Recipe that already
   * took over active_bom_id in the same transaction. Used when a Recipe's
   * status is changed away from 'active' directly (the update-status
   * action) — without this, master_skus.active_bom_id would keep pointing
   * at a no-longer-active Recipe.
   * Parameters: [sku_id, recipe_id]
   */
  clearActiveBomIdIfMatches: `UPDATE master_skus SET active_bom_id = NULL WHERE id = ? AND active_bom_id = ?`,

  /**
   * Designate the base SKU of a variant family — the member whose recipe owns
   * the family's RM. ALWAYS run as this pair, in one transaction:
   *
   *   clearBaseForFamily [brand, base_sku_sno]
   *   setBaseSku         [sku_id]
   *
   * "At most one base per family" holds BY CONSTRUCTION because of that order —
   * there is no unique index behind it (MySQL has no filtered unique index, and
   * one on (brand, base_sku_sno, is_base_sku) would wrongly forbid two NON-base
   * members). Run them apart, or in the other order, and a family can end up
   * with two bases — after which resolveRmLock's `family.find(isBase)` silently
   * picks whichever sorts first by sku_code. See
   * app/api/v1/masters/skus/route.ts, action "set-base".
   *
   * Parameters: [brand, base_sku_sno]
   */
  clearBaseForFamily: `UPDATE master_skus SET is_base_sku = 0 WHERE brand = ? AND base_sku_sno = ?`,

  /** Second half of the pair above. Parameters: [sku_id] */
  setBaseSku: `UPDATE master_skus SET is_base_sku = 1 WHERE id = ?`,

  /** The family grouping key for one SKU, needed before clearBaseForFamily.
   *  Parameters: [sku_id] */
  selectFamilyKeyById: `SELECT brand, base_sku_sno FROM master_skus WHERE id = ? LIMIT 1`,

  /** Fetch SKU status by sku_code — used to gate PO creation. Parameters: [sku_code] */
  selectStatusByCode: `SELECT status FROM master_skus WHERE sku_code = ? LIMIT 1`,

  /** Fetch SKU status + brand by sku_code — used for PO number generation. Parameters: [sku_code] */
  selectStatusAndBrandByCode: `SELECT status, brand FROM master_skus WHERE sku_code = ? LIMIT 1`,
  /** The brand a SKU belongs to, for the write-side brand guard. NULL brand_id
   *  means unattributed, which the guard allows.
   *  Parameters: [sku_code] */
  selectBrandIdByCode: `SELECT brand_id FROM master_skus WHERE sku_code = ? LIMIT 1`,

  /** Same, by id — recipes and misc costs reach a SKU by id, not code.
   *  Parameters: [id] */
  selectBrandIdById: `SELECT brand_id FROM master_skus WHERE id = ? LIMIT 1`,

  /** Brand ids for many SKU codes at once — for bulk uploads and multi-line
   *  invoices, which would otherwise issue one query per row.
   *  Parameters: [skuCodes] — needs query(), not execute(), for IN (?) expansion. */
  selectBrandIdsByCodes: `
    SELECT sku_code, brand_id FROM master_skus WHERE sku_code IN (?)
  `,

}
