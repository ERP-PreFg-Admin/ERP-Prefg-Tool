/**
 * Manufacturing Queries
 *
 * Real table: master_recipe_mfg — the SKU (via master_recipe) ↔ Manufacturer link,
 * joined for the Manufacturing module's per-manufacturer line list and the
 * cross-manufacturer overview. Open PO figures come from purchase_orders.
 *
 * master_recipe_mfg columns: id, recipe_id, mfg_id, status, effective_from,
 *   effective_to, monthly_capacity, this_month_plan, last_batch_date,
 *   remarks, created_on, created_by
 */

import { SQL_TODAY_IST } from "@/lib/date"

const LINES_SELECT = `
  SELECT
    l.id, l.recipe_id, l.mfg_id, l.status, l.effective_from, l.effective_to,
    l.monthly_capacity, l.this_month_plan, l.last_batch_date, l.remarks,
    b.bom_code,
    sk.sku_code, sk.name AS sku_name, sk.brand,
    sk.filling, sk.filling_uom,
    m.code AS mfg_code, m.name AS mfg_name
  FROM master_recipe_mfg l
  INNER JOIN master_recipe    b  ON b.id     = l.recipe_id
  LEFT  JOIN master_skus   sk ON sk.id    = b.sku_id
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

  /**
   * Lines still "live" for this manufacturer — status 'active' or
   * 'discontinued' (discontinued lines can still consume existing ingredient
   * stock and still be raised against; only 'inactive' is excluded). Used
   * everywhere PO-raising eligibility or Agreed Final Costing needs to know
   * which lines are currently producible. Params: [mfg_id]
   */
  selectLiveLinesByMfg: `
    ${LINES_SELECT}
    WHERE l.mfg_id = ? AND l.status IN ('active', 'discontinued')
    ORDER BY sk.sku_code ASC
  `,

  /** Per-status line counts for one manufacturer's tab badges. Params: [mfg_id] */
  statusCountsByMfg: `
    SELECT l.status, COUNT(*) AS cnt
    FROM master_recipe_mfg l
    WHERE l.mfg_id = ?
    GROUP BY l.status
  `,

  /**
   * This calendar month's PO qty vs received qty per SKU, for one
   * manufacturer's detail page header. Draft/cancelled/rejected POs never
   * became a real commitment, so they're excluded — everything else
   * (raised through received) counts toward "ordered this month" even if
   * still in flight. Uses the DB's own clock rather than an app-computed date
   * range since `date` is itself written the same way at PO insert time (see
   * purchaseOrdersSql.insert/insertNormal) — same clock on both ends. That
   * clock is IST via SQL_TODAY_IST, not the session's UTC: on the 1st of a
   * month before 05:30 IST a plain CURDATE() still reports last month, while
   * the heading above this table is rendered in IST and says the new one.
   * Params: [mfg_id]
   */
  selectMonthlyPoSummaryByMfg: `
    SELECT
      po.mfg_id, po.sku_code, sk.name AS sku_name,
      SUM(po.qty) AS po_qty,
      SUM(COALESCE(po.received_qty, 0)) AS received_qty
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    WHERE po.mfg_id = ?
      AND po.status NOT IN ('draft', 'cancelled', 'rejected')
      AND YEAR(po.date) = YEAR(${SQL_TODAY_IST}) AND MONTH(po.date) = MONTH(${SQL_TODAY_IST})
    GROUP BY po.mfg_id, po.sku_code, sk.name
    ORDER BY sk.name ASC
  `,

  /** Same as selectMonthlyPoSummaryByMfg but across every manufacturer at once — for the MFG Overview cards' mini table. Params: scopeParams(mfgIds) */
  selectMonthlyPoSummaryAllMfgs: `
    SELECT
      po.mfg_id, po.sku_code, sk.name AS sku_name,
      SUM(po.qty) AS po_qty,
      SUM(COALESCE(po.received_qty, 0)) AS received_qty
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    WHERE po.status NOT IN ('draft', 'cancelled', 'rejected')
      AND YEAR(po.date) = YEAR(${SQL_TODAY_IST}) AND MONTH(po.date) = MONTH(${SQL_TODAY_IST})
      AND (? IS NULL OR po.mfg_id IN (?))
    GROUP BY po.mfg_id, po.sku_code, sk.name
    ORDER BY sk.name ASC
  `,

  /**
   * One row per active manufacturer with aggregated production + PO stats.
   * Production-share / fill-rate percentages are derived in application code
   * from these sums, not stored.
   * Params: scopeParams(mfgIds)
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
    LEFT JOIN master_recipe_mfg l ON l.mfg_id = m.id
    LEFT JOIN (
      SELECT mfg_id,
        COUNT(*) AS open_pos,
        SUM(COALESCE(total_amount, 0)) AS open_value
      FROM purchase_orders
      WHERE status NOT IN ('received', 'cancelled')
      GROUP BY mfg_id
    ) po ON po.mfg_id = m.id
    WHERE d.status = 'active'
      AND (? IS NULL OR m.id IN (?))
    GROUP BY m.id, m.code, m.name, po.open_pos, po.open_value
    ORDER BY m.code ASC
  `,

  /**
   * Active manufacturers for the sidebar's dynamic MFG Management tabs.
   * Entity-scoped: this runs on every authenticated request, so without the
   * clause every user receives every manufacturer's name.
   * Params: scopeParams(mfgIds)
   */
  selectActiveForNav: `
    SELECT m.id, m.name
    FROM master_mfgs m
    INNER JOIN details_mfg d ON d.mfg_id = m.id
    WHERE d.status = 'active'
      AND (? IS NULL OR m.id IN (?))
    ORDER BY m.code ASC
  `,

  /** Recipe options for the "Add line" dialog — active Recipes not yet linked to this manufacturer. Params: [mfg_id] */
  bomOptionsForMfg: `
    SELECT b.id, b.bom_code, sk.sku_code, sk.name AS sku_name
    FROM master_recipe b
    LEFT JOIN master_skus sk ON sk.id = b.sku_id
    WHERE b.status = 'active'
      AND b.id NOT IN (SELECT recipe_id FROM master_recipe_mfg WHERE mfg_id = ?)
    ORDER BY sk.sku_code ASC
  `,

  /**
   * Insert a new manufacturer↔Recipe line.
   * Params: [recipe_id, mfg_id, status, effective_from, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, created_by]
   */
  insertLine: `
    INSERT INTO master_recipe_mfg
      (recipe_id, mfg_id, status, effective_from, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Update an existing line's editable fields.
   * Params: [status, effective_to, monthly_capacity, this_month_plan, last_batch_date, remarks, id]
   */
  updateLine: `
    UPDATE master_recipe_mfg
    SET status = ?, effective_to = ?, monthly_capacity = ?, this_month_plan = ?, last_batch_date = ?, remarks = ?
    WHERE id = ?
  `,

  /** Fetch a single line by id — used to confirm ownership/mfg_id before update. Params: [id] */
  selectLineById: `
    SELECT id, recipe_id, mfg_id FROM master_recipe_mfg WHERE id = ? LIMIT 1
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
    INNER JOIN master_recipe  b  ON b.id  = bm.bom_id
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
    INNER JOIN master_recipe  b  ON b.id  = bm.bom_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE bm.mfg_id = ? AND bm.status = 'active'
    ORDER BY bm.type ASC, sk.sku_code ASC
  `,

  /** SKU/Recipe options scoped to lines this manufacturer already produces (for the JW/Shrink/Shipper/Wastage "Add" dialog). Params: [mfg_id] */
  selectMfgLineOptions: `
    SELECT DISTINCT mbm.recipe_id AS id, b.bom_code, sk.sku_code, sk.name AS sku_name
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id  = mbm.recipe_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE mbm.mfg_id = ?
    ORDER BY sk.sku_code ASC
  `,

  /**
   * Active SKUs this manufacturer currently produces (active production
   * line + active SKU) — used by the PO Procurement "Add PO" dialog once a
   * manufacturer is picked, to list orderable SKUs as rows. Params: [mfg_id]
   */
  /** PO-eligible SKUs for one manufacturer — a line is eligible while 'active' or 'discontinued'; only 'inactive' blocks new POs. Params: [mfg_id] */
  selectActiveSkusForMfg: `
    SELECT DISTINCT sk.sku_code, sk.name AS sku_name
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id  = mbm.recipe_id
    INNER JOIN master_skus sk ON sk.id = b.sku_id
    WHERE mbm.mfg_id = ? AND mbm.status IN ('active', 'discontinued') AND sk.status = 'active'
    ORDER BY sk.sku_code ASC
  `,

  /** Resolve one SKU code to the recipe_id this manufacturer produces it under — for the bulk misc-cost CSV importer. Params: [mfg_id, sku_code] */
  selectMfgLineBySkuCode: `
    SELECT DISTINCT mbm.recipe_id AS id
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id  = mbm.recipe_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    WHERE mbm.mfg_id = ? AND sk.sku_code = ?
    LIMIT 1
  `,

  /**
   * Insert a bom_misc cost line.
   * Params: [recipe_id, mfg_id, type, cost, effective_from, effective_till, status]
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
    FROM cost_master_rm_mfg rmm
    INNER JOIN master_rm      r ON r.id = rmm.rm_id
    LEFT  JOIN master_vendors v ON v.id = rmm.approved_vendor_id
    WHERE rmm.mfg_id = ?
    ORDER BY r.rm_code ASC
  `,

  /**
   * Past RM×vendor rate periods for this manufacturer — cost_master_rm_mfg itself
   * has no effective_to (the live row is open-ended), but every rate change
   * archives the superseded period into history_cost_mfg WITH both dates
   * (see rmRateHandler.applyAndArchive in lib/approvals/module-handlers.ts).
   * Params: [mfg_id]
   */
  selectRmVendorHistoryByMfg: `
    SELECT
      r.rm_code, r.name AS rm_name,
      v.name AS vendor_name,
      h.rate, h.effective_from, h.effective_to
    FROM history_cost_mfg h
    INNER JOIN master_rm r ON r.id = h.mtrl_id
    LEFT  JOIN master_vendors v ON v.id = h.vendor_id
    WHERE h.mfg_id = ? AND h.mtrl_type = 'rm'
    ORDER BY r.rm_code ASC, h.effective_from DESC
  `,

  /**
   * PM×mfg rates for the Approved Procurement Rates tab. cost_master_pm_mfg has no
   * approved-vendor column (unlike cost_master_rm_mfg), so the vendor is resolved
   * the same "best effort" way pmRateHandler.applyAndArchive does: whichever
   * active cost_master_pm_ven row exists for that PM, picked via a correlated
   * subquery so a PM with several active vendor rows still returns one row
   * here instead of fanning out. Params: [mfg_id]
   */
  selectPmVendorByMfg: `
    SELECT
      p.pm_code, p.name AS pm_name, p.type,
      vv.vendor_code AS approved_vendor_code, v.name AS vendor_name,
      pmm.curr_rate, pmm.effective_from, pmm.effective_to, pmm.uom, pmm.status
    FROM cost_master_pm_mfg pmm
    INNER JOIN master_pm p ON p.id = pmm.pm_id
    LEFT  JOIN cost_master_pm_ven vv ON vv.id = (
      SELECT id FROM cost_master_pm_ven WHERE pm_id = pmm.pm_id AND status = 'active' ORDER BY id LIMIT 1
    )
    LEFT  JOIN master_vendors v ON v.id = vv.vendor_id
    WHERE pmm.mfg_id = ?
    ORDER BY p.pm_code ASC
  `,

  /**
   * Past PM×vendor rate periods for this manufacturer (history_cost_mfg mirrors
   * selectRmVendorHistoryByMfg but filters mtrl_type = 'pm'). Params: [mfg_id]
   */
  selectPmVendorHistoryByMfg: `
    SELECT
      p.pm_code, p.name AS pm_name,
      v.name AS vendor_name,
      h.rate, h.effective_from, h.effective_to
    FROM history_cost_mfg h
    INNER JOIN master_pm p ON p.id = h.mtrl_id
    LEFT  JOIN master_vendors v ON v.id = h.vendor_id
    WHERE h.mfg_id = ? AND h.mtrl_type = 'pm'
    ORDER BY p.pm_code ASC, h.effective_from DESC
  `,

  // ── Agreed Rates (read-only, RM/PM toggle) ────────────────────────────────

  /** Agreed RM rates for this manufacturer. Note: cost_master_rm_mfg has no effective_to column. Params: [mfg_id] */
  selectAgreedRmRatesByMfg: `
    SELECT r.rm_code AS code, r.name, rmm.curr_rate, rmm.effective_from, rmm.uom, rmm.status
    FROM cost_master_rm_mfg rmm
    INNER JOIN master_rm r ON r.id = rmm.rm_id
    WHERE rmm.mfg_id = ?
    ORDER BY r.rm_code ASC
  `,

  /** Agreed PM rates for this manufacturer. Params: [mfg_id] */
  selectAgreedPmRatesByMfg: `
    SELECT p.pm_code AS code, p.name, pmm.curr_rate, pmm.effective_from, pmm.effective_to, pmm.uom, pmm.status
    FROM cost_master_pm_mfg pmm
    INNER JOIN master_pm p ON p.id = pmm.pm_id
    WHERE pmm.mfg_id = ?
    ORDER BY p.pm_code ASC
  `,

  // ── Agreed Final Costing (read-only, computed) ────────────────────────────

  /**
   * Per-bom RM/PM material cost for this manufacturer's live lines (status
   * 'active' or 'discontinued' — see selectLiveLinesByMfg's comment; a
   * discontinued line is still producible, so its costing still applies).
   *
   * RM lines (details_recipe.amount) are a formulation PERCENTAGE, not a
   * quantity — the Recipe editor requires all RM lines on a SKU to sum to
   * ~100% (see lib/validation/bom.ts). RM rates (cost_master_rm_mfg.curr_rate)
   * are agreed per KG, while the SKU's fill weight (master_skus.filling) is
   * in grams. So the RM grams actually used per unit = filling * pct/100,
   * converted to kg (/1000) before multiplying by the per-kg rate:
   *   rm_cost = filling(g) * amount(%) * curr_rate(/kg) / 100 / 1000
   * A SKU with no filling recorded contributes 0 for that line (SUM skips
   * the resulting NULL), same as a missing rate does today.
   *
   * Filling is read from master_skus (the SKU master's own source of truth,
   * same column lib/queries/skus.ts uses), not details_sku — details_sku
   * carries a separate, unsynced copy that can drift from the real value.
   *
   * PM lines are unit-wise (details_recipe.amount is a plain per-unit qty), so
   * PM cost stays a straight quantity × rate multiplication.
   *
   * Rate joins are pinned to status='active' AND this exact mfg_id so a
   * material with multiple rate rows (draft/inactive history, or rates for
   * other manufacturers) can't fan out the join and inflate the SUM.
   * Params: [mfg_id, mfg_id, mfg_id]
   */
  selectMaterialCostByMfg: `
    SELECT mbm.recipe_id,
      COALESCE(SUM(CASE WHEN db.mtrl_type = 'rm' THEN (db.amount * sk.filling * rmm.curr_rate) / 100000 ELSE 0 END), 0) AS rm_cost,
      COALESCE(SUM(CASE WHEN db.mtrl_type = 'pm' THEN db.amount * pmm.curr_rate ELSE 0 END), 0) AS pm_cost
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id = mbm.recipe_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    INNER JOIN details_recipe db ON db.recipe_id = mbm.recipe_id AND db.status = 'active'
    LEFT  JOIN cost_master_rm_mfg rmm ON rmm.rm_id = db.mtrl_id AND rmm.mfg_id = ? AND rmm.status = 'active' AND db.mtrl_type = 'rm'
    LEFT  JOIN cost_master_pm_mfg pmm ON pmm.pm_id = db.mtrl_id AND pmm.mfg_id = ? AND pmm.status = 'active' AND db.mtrl_type = 'pm'
    WHERE mbm.mfg_id = ? AND mbm.status IN ('active', 'discontinued')
    GROUP BY mbm.recipe_id
  `,

  /** Active JW/Shrink/Shipper costs for this manufacturer, keyed by recipe_id + type in application code. Params: [mfg_id] */
  selectMiscCostsByMfg: `
    SELECT bom_id, type, cost FROM bom_misc WHERE mfg_id = ? AND status = 'active'
  `,

  /**
   * Per-bom-line RM/PM inputs (mtrl_type, mtrl_id, amount, filling) for this
   * manufacturer's active lines — used to recompute RM/PM cost at an
   * arbitrary rate (cheapest/max vendor rate) instead of the agreed MRM
   * rate, via lib/costing/final-costing.ts's computeRmCost/computePmCost.
   * Filling sourced from master_skus (see selectMaterialCostByMfg's comment).
   * Params: [mfg_id]
   */
  selectBomLineInputsByMfg: `
    SELECT mbm.recipe_id, db.mtrl_type, db.mtrl_id, db.amount, sk.filling
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id = mbm.recipe_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    INNER JOIN details_recipe db ON db.recipe_id = mbm.recipe_id AND db.status = 'active'
    WHERE mbm.mfg_id = ? AND mbm.status IN ('active', 'discontinued')
  `,

  /**
   * Same per-bom-line scope as selectBomLineInputsByMfg, but also resolves
   * the material's code/name and its agreed MRM rate — used only by the
   * Agreed Final Costing "Detailed Breakup" export, which needs line-level
   * (not bom-aggregated) figures to build a per-material negotiation sheet.
   * Params: [mfg_id, mfg_id, mfg_id]
   */
  selectBomLineDetailByMfg: `
    SELECT
      mbm.recipe_id, sk.sku_code, sk.name AS sku_name,
      db.mtrl_type, db.mtrl_id, db.amount, sk.filling,
      CASE WHEN db.mtrl_type = 'rm' THEN r.rm_code ELSE p.pm_code END AS mtrl_code,
      CASE WHEN db.mtrl_type = 'rm' THEN r.name    ELSE p.name    END AS mtrl_name,
      CASE WHEN db.mtrl_type = 'rm' THEN rmm.curr_rate ELSE pmm.curr_rate END AS mrm_rate
    FROM master_recipe_mfg mbm
    INNER JOIN master_recipe  b  ON b.id = mbm.recipe_id
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    INNER JOIN details_recipe db ON db.recipe_id = mbm.recipe_id AND db.status = 'active'
    LEFT  JOIN master_rm r ON r.id = db.mtrl_id AND db.mtrl_type = 'rm'
    LEFT  JOIN master_pm p ON p.id = db.mtrl_id AND db.mtrl_type = 'pm'
    LEFT  JOIN cost_master_rm_mfg rmm ON rmm.rm_id = db.mtrl_id AND rmm.mfg_id = ? AND rmm.status = 'active' AND db.mtrl_type = 'rm'
    LEFT  JOIN cost_master_pm_mfg pmm ON pmm.pm_id = db.mtrl_id AND pmm.mfg_id = ? AND pmm.status = 'active' AND db.mtrl_type = 'pm'
    WHERE mbm.mfg_id = ? AND mbm.status IN ('active', 'discontinued')
  `,
}
