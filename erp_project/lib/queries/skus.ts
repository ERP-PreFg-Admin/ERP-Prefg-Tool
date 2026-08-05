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

  /** Active SKUs only — used to populate the BOM wizard's SKU picker. */
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
   * category + subcategory + missing-BOM filters. Also joins a `variant_count`
   * column (SKUs sharing this row's brand + base_sku_sno) so the client can
   * decide, per row, whether the "see variants" row action should be shown
   * (variant_count > 1).
   * Params: [like, like, like, like, status, status, brand, brand, sku_type, sku_type, category, category, subcategory, subcategory, missingBom, LIMIT, OFFSET]
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
   * Params: [like, like, like, like, status, status, brand, brand, sku_type, sku_type, category, category, subcategory, subcategory, missingBom]
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
    SELECT id, sku_code, name, sku_type, category, subcategory, filling, filling_uom, mrp, status
    FROM master_skus
    WHERE brand = ? AND base_sku_sno = ?
    ORDER BY sku_code ASC
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
   * Params: [like, like, like, like, status, status, brand, brand, sku_type, sku_type, category, category, subcategory, subcategory]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM master_skus
    WHERE (? IS NULL OR sku_code LIKE ? OR name LIKE ? OR brand LIKE ?)
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
  updateSku: `
    UPDATE master_skus
    SET name = ?, brand = ?, category = ?, subcategory = ?, sku_type = ?, mrp = ?, status = ?
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
   * Point a SKU at its currently-active BOM — called whenever a BOM
   * transitions TO 'active' (bomHandler.applyAndArchive on approval,
   * bomBulkHandler.applyAndArchive, and the update-status action), so
   * master_skus.active_bom_id never goes stale. This is what the SKU
   * master list's bom_code column resolves (see skus.selectPaginated's
   * active_bom_id -> app/masters/skus/page.tsx's selectBomCodesByIds join).
   * Parameters: [bom_id, sku_id]
   */
  setActiveBomId: `UPDATE master_skus SET active_bom_id = ? WHERE id = ?`,

  /**
   * Clear a SKU's active_bom_id, but ONLY if it still points at the BOM
   * being deactivated — guards against clobbering a newer BOM that already
   * took over active_bom_id in the same transaction. Used when a BOM's
   * status is changed away from 'active' directly (the update-status
   * action) — without this, master_skus.active_bom_id would keep pointing
   * at a no-longer-active BOM.
   * Parameters: [sku_id, bom_id]
   */
  clearActiveBomIdIfMatches: `UPDATE master_skus SET active_bom_id = NULL WHERE id = ? AND active_bom_id = ?`,

  /** Fetch SKU status by sku_code — used to gate PO creation. Parameters: [sku_code] */
  selectStatusByCode: `SELECT status FROM master_skus WHERE sku_code = ? LIMIT 1`,

  /** Fetch SKU status + brand by sku_code — used for PO number generation. Parameters: [sku_code] */
  selectStatusAndBrandByCode: `SELECT status, brand FROM master_skus WHERE sku_code = ? LIMIT 1`,
}
