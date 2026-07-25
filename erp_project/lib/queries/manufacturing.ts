/**
 * Manufacturing Queries
 *
 * Real table: master_bom_mfg — the SKU (via master_bom) ↔ Manufacturer link,
 * joined for the Manufacturing module's per-manufacturer line list and the
 * cross-manufacturer overview. Open PO figures come from purchase_orders.
 *
 * master_bom_mfg columns: id, bom_id, mfg_id, status, effective_from,
 *   effective_to, monthly_capacity, this_month_plan, last_batch_date,
 *   remarks, created_on, created_by
 */

const LINES_SELECT = `
  SELECT
    l.id, l.bom_id, l.mfg_id, l.status, l.effective_from, l.effective_to,
    l.monthly_capacity, l.this_month_plan, l.last_batch_date, l.remarks,
    b.bom_code,
    sk.sku_code, sk.name AS sku_name, sk.brand,
    ds.filling, ds.filling_uom,
    m.code AS mfg_code, m.name AS mfg_name
  FROM master_bom_mfg l
  INNER JOIN master_bom    b  ON b.id     = l.bom_id
  LEFT  JOIN master_skus   sk ON sk.id    = b.sku_id
  LEFT  JOIN details_sku   ds ON ds.sku_id = sk.id
  INNER JOIN master_mfgs   m  ON m.id     = l.mfg_id
`

export const manufacturingSql = {
  /**
   * All lines for one manufacturer, optionally filtered by status.
   * Params: [mfg_id, status, status]  (status is null to disable the filter)
   */
  selectLinesByMfg: `
    ${LINES_SELECT}
    WHERE l.mfg_id = ? AND (? IS NULL OR l.status = ?)
    ORDER BY sk.sku_code ASC
  `,

  /** Per-status line counts for one manufacturer's tab badges. Params: [mfg_id] */
  statusCountsByMfg: `
    SELECT l.status, COUNT(*) AS cnt
    FROM master_bom_mfg l
    WHERE l.mfg_id = ?
    GROUP BY l.status
  `,

  /**
   * One row per active manufacturer with aggregated production + PO stats.
   * Production-share / fill-rate percentages are derived in application code
   * from these sums, not stored.
   */
  overviewByMfg: `
    SELECT
      m.id, m.code, m.name,
      COALESCE(SUM(CASE WHEN l.status = 'active' THEN l.monthly_capacity ELSE 0 END), 0) AS capacity,
      COALESCE(SUM(CASE WHEN l.status = 'active' THEN l.this_month_plan  ELSE 0 END), 0) AS this_month_plan,
      COUNT(CASE WHEN l.status = 'active' THEN 1 END) AS active_skus,
      COALESCE(po.open_pos, 0)   AS open_pos,
      COALESCE(po.open_value, 0) AS open_value
    FROM master_mfgs m
    INNER JOIN details_mfg d ON d.mfg_id = m.id
    LEFT JOIN master_bom_mfg l ON l.mfg_id = m.id
    LEFT JOIN (
      SELECT mfg_id,
        COUNT(*) AS open_pos,
        SUM(COALESCE(total_amount, 0)) AS open_value
      FROM purchase_orders
      WHERE status NOT IN ('received', 'cancelled')
      GROUP BY mfg_id
    ) po ON po.mfg_id = m.id
    WHERE d.status = 'active'
    GROUP BY m.id, m.code, m.name, po.open_pos, po.open_value
    ORDER BY m.code ASC
  `,

  /** Active manufacturers for the sidebar's dynamic MFG Management tabs. */
  selectActiveForNav: `
    SELECT m.id, m.name
    FROM master_mfgs m
    INNER JOIN details_mfg d ON d.mfg_id = m.id
    WHERE d.status = 'active'
    ORDER BY m.code ASC
  `,

  /** BOM options for the "Add line" dialog — active BOMs not yet linked to this manufacturer. Params: [mfg_id] */
  bomOptionsForMfg: `
    SELECT b.id, b.bom_code, sk.sku_code, sk.name AS sku_name
    FROM master_bom b
    LEFT JOIN master_skus sk ON sk.id = b.sku_id
    WHERE b.status = 'active'
      AND b.id NOT IN (SELECT bom_id FROM master_bom_mfg WHERE mfg_id = ?)
    ORDER BY sk.sku_code ASC
  `,

  /**
   * Insert a new manufacturer↔BOM line.
   * Params: [bom_id, mfg_id, status, effective_from, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, created_by]
   */
  insertLine: `
    INSERT INTO master_bom_mfg
      (bom_id, mfg_id, status, effective_from, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Update an existing line's editable fields.
   * Params: [status, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, id]
   */
  updateLine: `
    UPDATE master_bom_mfg
    SET status = ?, effective_to = ?, monthly_capacity = ?, this_month_plan = ?, last_batch_date = ?, remarks = ?
    WHERE id = ?
  `,

  /** Fetch a single line by id — used to confirm ownership/mfg_id before update. Params: [id] */
  selectLineById: `
    SELECT id, bom_id, mfg_id FROM master_bom_mfg WHERE id = ? LIMIT 1
  `,

  // ── Misc. Cost: JW / Shrink Wrap / Shipper / Wastage (bom_misc) ────────────
  // rm_loss/pm_loss hold a wastage PERCENTAGE in the same `cost` column
  // jw/shrink/shipper use for an absolute currency amount.

  /** All JW/Shrink/Shipper/Wastage lines for one manufacturer — the client toggles between types. Params: [mfg_id] */
  selectMiscByMfg: `
    SELECT
      bm.id, bm.bom_id, bm.mfg_id, bm.type, bm.cost,
      bm.effective_from, bm.effective_till, bm.status,
      b.bom_code, sk.sku_code, sk.name AS sku_name
    FROM bom_misc bm
    INNER JOIN master_bom  b  ON b.id  = bm.bom_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE bm.mfg_id = ? AND bm.type IN ('jw', 'shrink', 'shipper', 'rm_loss', 'pm_loss')
    ORDER BY sk.sku_code ASC
  `,

  /** Current (active) JW/Shrink/Shipper/Wastage lines for one manufacturer, across all types — for the "Download CSV/Excel" export. Params: [mfg_id] */
  selectMiscCurrentRatesByMfg: `
    SELECT
      bm.type, b.bom_code, sk.sku_code, sk.name AS sku_name,
      bm.cost, bm.effective_from, bm.effective_till, bm.status
    FROM bom_misc bm
    INNER JOIN master_bom  b  ON b.id  = bm.bom_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE bm.mfg_id = ? AND bm.status = 'active'
    ORDER BY bm.type ASC, sk.sku_code ASC
  `,

  /** SKU/BOM options scoped to lines this manufacturer already produces (for the JW/Shrink/Shipper/Wastage "Add" dialog). Params: [mfg_id] */
  selectMfgLineOptions: `
    SELECT DISTINCT mbm.bom_id AS id, b.bom_code, sk.sku_code, sk.name AS sku_name
    FROM master_bom_mfg mbm
    INNER JOIN master_bom  b  ON b.id  = mbm.bom_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE mbm.mfg_id = ?
    ORDER BY sk.sku_code ASC
  `,

  /** Resolve one SKU code to the bom_id this manufacturer produces it under — for the bulk misc-cost CSV importer. Params: [mfg_id, sku_code] */
  selectMfgLineBySkuCode: `
    SELECT DISTINCT mbm.bom_id AS id
    FROM master_bom_mfg mbm
    INNER JOIN master_bom  b  ON b.id  = mbm.bom_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE mbm.mfg_id = ? AND sk.sku_code = ?
    LIMIT 1
  `,

  /**
   * Insert a bom_misc cost line.
   * Params: [bom_id, mfg_id, type, cost, effective_from, effective_till, status]
   */
  insertMisc: `
    INSERT INTO bom_misc (bom_id, mfg_id, type, cost, effective_from, effective_till, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Update a bom_misc cost line's editable fields.
   * Params: [cost, effective_from, effective_till, status, id]
   */
  updateMisc: `
    UPDATE bom_misc
    SET cost = ?, effective_from = ?, effective_till = ?, status = ?
    WHERE id = ?
  `,

  /** Fetch a single bom_misc line by id. Params: [id] */
  selectMiscLineById: `
    SELECT id, bom_id, mfg_id, type FROM bom_misc WHERE id = ? LIMIT 1
  `,

  // ── RM Vendor (read-only) ─────────────────────────────────────────────────

  /** RM this manufacturer sources, with its approved vendor. Params: [mfg_id] */
  selectRmVendorByMfg: `
    SELECT
      r.rm_code, r.name AS rm_name, r.make, r.type,
      rmm.approved_vendor_code, v.name AS vendor_name,
      rmm.curr_rate, rmm.effective_from, rmm.uom, rmm.status
    FROM rm_mrm_fixed rmm
    INNER JOIN master_rm      r ON r.id = rmm.rm_id
    LEFT  JOIN master_vendors v ON v.id = rmm.approved_vendor_id
    WHERE rmm.mfg_id = ?
    ORDER BY r.rm_code ASC
  `,

  /**
   * Past RM×vendor rate periods for this manufacturer — rm_mrm_fixed itself
   * has no effective_to (the live row is open-ended), but every rate change
   * archives the superseded period into history_mrm WITH both dates
   * (see rmRateHandler.applyAndArchive in lib/approvals/module-handlers.ts).
   * Params: [mfg_id]
   */
  selectRmVendorHistoryByMfg: `
    SELECT
      r.rm_code, r.name AS rm_name,
      v.name AS vendor_name,
      h.rate, h.effective_from, h.effective_to
    FROM history_mrm h
    INNER JOIN master_rm r ON r.id = h.mtrl_id
    LEFT  JOIN master_vendors v ON v.id = h.vendor_id
    WHERE h.mfg_id = ? AND h.mtrl_type = 'rm'
    ORDER BY r.rm_code ASC, h.effective_from DESC
  `,

  /**
   * PM×mfg rates for the Approved Procurement Rates tab. pm_mrm_fixed has no
   * approved-vendor column (unlike rm_mrm_fixed), so the vendor is resolved
   * the same "best effort" way pmRateHandler.applyAndArchive does: whichever
   * active pm_vrm_dynamic row exists for that PM, picked via a correlated
   * subquery so a PM with several active vendor rows still returns one row
   * here instead of fanning out. Params: [mfg_id]
   */
  selectPmVendorByMfg: `
    SELECT
      p.pm_code, p.name AS pm_name, p.type,
      vv.vendor_code AS approved_vendor_code, v.name AS vendor_name,
      pmm.curr_rate, pmm.effective_from, pmm.effective_to, pmm.uom, pmm.status
    FROM pm_mrm_fixed pmm
    INNER JOIN master_pm p ON p.id = pmm.pm_id
    LEFT  JOIN pm_vrm_dynamic vv ON vv.id = (
      SELECT id FROM pm_vrm_dynamic WHERE pm_id = pmm.pm_id AND status = 'active' ORDER BY id LIMIT 1
    )
    LEFT  JOIN master_vendors v ON v.id = vv.vendor_id
    WHERE pmm.mfg_id = ?
    ORDER BY p.pm_code ASC
  `,

  /**
   * Past PM×vendor rate periods for this manufacturer (history_mrm mirrors
   * selectRmVendorHistoryByMfg but filters mtrl_type = 'pm'). Params: [mfg_id]
   */
  selectPmVendorHistoryByMfg: `
    SELECT
      p.pm_code, p.name AS pm_name,
      v.name AS vendor_name,
      h.rate, h.effective_from, h.effective_to
    FROM history_mrm h
    INNER JOIN master_pm p ON p.id = h.mtrl_id
    LEFT  JOIN master_vendors v ON v.id = h.vendor_id
    WHERE h.mfg_id = ? AND h.mtrl_type = 'pm'
    ORDER BY p.pm_code ASC, h.effective_from DESC
  `,

  // ── Agreed Rates (read-only, RM/PM toggle) ────────────────────────────────

  /** Agreed RM rates for this manufacturer. Note: rm_mrm_fixed has no effective_to column. Params: [mfg_id] */
  selectAgreedRmRatesByMfg: `
    SELECT r.rm_code AS code, r.name, rmm.curr_rate, rmm.effective_from, rmm.uom, rmm.status
    FROM rm_mrm_fixed rmm
    INNER JOIN master_rm r ON r.id = rmm.rm_id
    WHERE rmm.mfg_id = ?
    ORDER BY r.rm_code ASC
  `,

  /** Agreed PM rates for this manufacturer. Params: [mfg_id] */
  selectAgreedPmRatesByMfg: `
    SELECT p.pm_code AS code, p.name, pmm.curr_rate, pmm.effective_from, pmm.effective_to, pmm.uom, pmm.status
    FROM pm_mrm_fixed pmm
    INNER JOIN master_pm p ON p.id = pmm.pm_id
    WHERE pmm.mfg_id = ?
    ORDER BY p.pm_code ASC
  `,

  // ── Agreed Final Costing (read-only, computed) ────────────────────────────

  /**
   * Per-bom RM/PM material cost for this manufacturer's active lines.
   *
   * RM lines (details_bom.amount) are a formulation PERCENTAGE, not a
   * quantity — the BOM editor requires all RM lines on a SKU to sum to
   * ~100% (see lib/validation/bom.ts). RM rates (rm_mrm_fixed.curr_rate)
   * are agreed per KG, while the SKU's fill weight (details_sku.filling) is
   * in grams. So the RM grams actually used per unit = filling * pct/100,
   * converted to kg (/1000) before multiplying by the per-kg rate:
   *   rm_cost = filling(g) * amount(%) * curr_rate(/kg) / 100 / 1000
   * A SKU with no filling recorded contributes 0 for that line (SUM skips
   * the resulting NULL), same as a missing rate does today.
   *
   * PM lines are unit-wise (details_bom.amount is a plain per-unit qty), so
   * PM cost stays a straight quantity × rate multiplication.
   *
   * Rate joins are pinned to status='active' AND this exact mfg_id so a
   * material with multiple rate rows (draft/inactive history, or rates for
   * other manufacturers) can't fan out the join and inflate the SUM.
   * Params: [mfg_id, mfg_id, mfg_id]
   */
  selectMaterialCostByMfg: `
    SELECT mbm.bom_id,
      COALESCE(SUM(CASE WHEN db.mtrl_type = 'rm' THEN (db.amount * ds.filling * rmm.curr_rate) / 100000 ELSE 0 END), 0) AS rm_cost,
      COALESCE(SUM(CASE WHEN db.mtrl_type = 'pm' THEN db.amount * pmm.curr_rate ELSE 0 END), 0) AS pm_cost
    FROM master_bom_mfg mbm
    INNER JOIN master_bom  b  ON b.id = mbm.bom_id
    LEFT  JOIN details_sku ds ON ds.sku_id = b.sku_id
    INNER JOIN details_bom db ON db.bom_id = mbm.bom_id AND db.status = 'active'
    LEFT  JOIN rm_mrm_fixed rmm ON rmm.rm_id = db.mtrl_id AND rmm.mfg_id = ? AND rmm.status = 'active' AND db.mtrl_type = 'rm'
    LEFT  JOIN pm_mrm_fixed pmm ON pmm.pm_id = db.mtrl_id AND pmm.mfg_id = ? AND pmm.status = 'active' AND db.mtrl_type = 'pm'
    WHERE mbm.mfg_id = ? AND mbm.status = 'active'
    GROUP BY mbm.bom_id
  `,

  /** Active JW/Shrink/Shipper costs for this manufacturer, keyed by bom_id + type in application code. Params: [mfg_id] */
  selectMiscCostsByMfg: `
    SELECT bom_id, type, cost FROM bom_misc WHERE mfg_id = ? AND status = 'active'
  `,
}
