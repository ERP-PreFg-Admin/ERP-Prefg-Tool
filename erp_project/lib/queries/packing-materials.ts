/**
 * Packing Materials (PM) Queries
 * Centralized queries for the pm table and related rate tables (pm_vrm_dynamic, pm_mrm_fixed)
 */

import { scopeParams, type UserScope } from "@/lib/scope"

export const packingMaterials = {
  /** Get all packing materials (base data only, no rate joins) */
  selectAll: `
    SELECT id, pm_code, name, type, uom, status, hsn_code
    FROM master_pm ORDER BY name
  `,

  /** Active packing materials only — used to populate the BOM wizard's PM picker. */
  selectActive: `
    SELECT id, pm_code, name, uom, status
    FROM master_pm
    WHERE status = 'active'
    ORDER BY name
  `,

  /** Active packing materials with every field the cost-master "Add Rates"
   *  wizard needs to display once a material is picked. */
  selectActiveFull: `
    SELECT id, pm_code, name, type, uom, hsn_code
    FROM master_pm
    WHERE status = 'active'
    ORDER BY name
  `,

   /** Get all Packing material along with vendor details and prices. */
  selectAllByVendor: `
    SELECT
      p.pm_code, p.name, p.type,
      p.hsn_code, pmv.pm_id, pmv.id AS vrm_id,
      pmv.vendor_id, pmv.vendor_code,
      pmv.curr_rate, pmv.moq,
      pmv.uom, pmv.status,
      pmv.effective_from, pmv.effective_to
    FROM pm_vrm_dynamic AS pmv
    INNER JOIN master_pm AS p ON pmv.pm_id = p.id
  `,
  /**
   * Cheapest and most expensive currently-effective vendor (VRM) rate per PM,
   * across ALL vendors (not scoped to any one manufacturer). Mirrors
   * rawMaterials.selectMinMaxVrmRateByRm — see that query's comment for the
   * correlated-subquery vendor-resolution rationale and why the vendor-scope
   * clause has to appear in all three places.
   * Params: scopeParams(vendorIds) × 3 (6 total)
   */
  selectMinMaxVrmRateByPm: `
    SELECT
      agg.pm_id, agg.min_rate, agg.max_rate,
      minv.code AS min_vendor_code, minv.name AS min_vendor_name,
      maxv.code AS max_vendor_code, maxv.name AS max_vendor_name
    FROM (
      SELECT pm_id, MIN(curr_rate) AS min_rate, MAX(curr_rate) AS max_rate
      FROM pm_vrm_dynamic
      WHERE status = 'active'
        AND effective_from <= CURDATE()
        AND (effective_to IS NULL OR effective_to >= CURDATE())
        AND (? IS NULL OR vendor_id IN (?))
      GROUP BY pm_id
    ) agg
    LEFT JOIN master_vendors minv ON minv.id = (
      SELECT vendor_id FROM pm_vrm_dynamic
      WHERE pm_id = agg.pm_id AND curr_rate = agg.min_rate AND status = 'active'
        AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())
        AND (? IS NULL OR vendor_id IN (?))
      ORDER BY id LIMIT 1
    )
    LEFT JOIN master_vendors maxv ON maxv.id = (
      SELECT vendor_id FROM pm_vrm_dynamic
      WHERE pm_id = agg.pm_id AND curr_rate = agg.max_rate AND status = 'active'
        AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())
        AND (? IS NULL OR vendor_id IN (?))
      ORDER BY id LIMIT 1
    )
  `,

  /** Get all Packing material along with manufacturer details and prices. */
  selectAllByManufacturer: `
    SELECT
      p.pm_code, p.name, p.type,
      p.hsn_code, p.uom, pmm.pm_id, pmm.id AS rate_id,
      pmm.mfg_id, pmm.mfg_code, pmm.curr_rate,
      pmm.uom, pmm.status, pmm.effective_from
    FROM pm_mrm_fixed AS pmm
    INNER JOIN master_pm AS p ON pmm.pm_id = p.id
  `,

  /** Select a packing material by its code for bulk import purposes. */
  selectByCode: `select id , uom, status from master_pm where pm_code = ? limit 1`,
  // ============ PAGINATED BASE TABLE QUERIES (material-master page) ============

  /**
   * Fetch ALL matching base PM rows for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated.
   * Params: [like, like, like, like, status, status]
   */
  /**
   * Fetch ALL matching base PM rows for export.
   * Params: [like×4, status×2, type×2]
   */
  selectBaseAllFiltered: `
    SELECT id, pm_code, name, type, uom, status, hsn_code, pantone_color
    FROM master_pm
    WHERE (? IS NULL OR pm_code LIKE ? OR name LIKE ? OR type LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR type = ?)
    ORDER BY name ASC
  `,

  /**
   * Paginated base PM list with optional search + status + type filter.
   * Params: [like×4, status×2, type×2, LIMIT, OFFSET]
   */
  selectPaginated: `
    SELECT id, pm_code, name, type, uom, status, hsn_code, pantone_color
    FROM master_pm
    WHERE (? IS NULL OR pm_code LIKE ? OR name LIKE ? OR type LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR type = ?)
    ORDER BY name ASC
    LIMIT ? OFFSET ?
  `,

  /** Matching COUNT for selectPaginated. Params: [like×4, status×2, type×2] */
  countAll: `
    SELECT COUNT(*) AS total FROM master_pm
    WHERE (? IS NULL OR pm_code LIKE ? OR name LIKE ? OR type LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR type = ?)
  `,

  /**
   * Update PM base record fields.
   * Params: [name, type, uom, status, hsn_code, pantone_color, id]
   */
  update: `
    UPDATE master_pm
    SET name = ?, type = ?, uom = ?, status = ?, hsn_code = ?, pantone_color = ?
    WHERE id = ?
  `,

  // ============ PAGINATED SELECT QUERIES (packing-materials rate page) ============

  /**
   * Paginated PM × vendor rates with optional search + status + make + vendor_code
   * + rate_min/max + effective_from filter.
   * Params: vendorFilterParams(...) + [LIMIT, OFFSET]
   *   [like×3, status×2, make×2, vcLike×2, rateMin×2, rateMax×2, effFrom×2, LIMIT, OFFSET]
   */
  selectVendorPaginated: `
    SELECT
      p.pm_code, p.name, p.type, p.pantone_color,
      p.hsn_code, pmv.pm_id, pmv.id AS vrm_id,
      pmv.vendor_id, pmv.vendor_code,
      pmv.curr_rate, pmv.moq,
      pmv.uom, pmv.status,
      pmv.effective_from, pmv.effective_to
    FROM pm_vrm_dynamic AS pmv
    INNER JOIN master_pm AS p ON pmv.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmv.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmv.vendor_code LIKE ?)
      AND (? IS NULL OR pmv.curr_rate >= ?)
      AND (? IS NULL OR pmv.curr_rate <= ?)
      AND (? IS NULL OR pmv.effective_from >= ?)
      AND (? IS NULL OR pmv.vendor_id IN (?))
    ORDER BY p.pm_code ASC
    LIMIT ? OFFSET ?
  `,

  selectVendorAllFiltered: `
    SELECT
      p.pm_code, p.name, p.type, p.pantone_color,
      p.hsn_code, pmv.pm_id, pmv.id AS vrm_id,
      pmv.vendor_id, pmv.vendor_code,
      pmv.curr_rate, pmv.moq,
      pmv.uom, pmv.status,
      pmv.effective_from, pmv.effective_to
    FROM pm_vrm_dynamic AS pmv
    INNER JOIN master_pm AS p ON pmv.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmv.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmv.vendor_code LIKE ?)
      AND (? IS NULL OR pmv.curr_rate >= ?)
      AND (? IS NULL OR pmv.curr_rate <= ?)
      AND (? IS NULL OR pmv.effective_from >= ?)
      AND (? IS NULL OR pmv.vendor_id IN (?))
    ORDER BY p.pm_code ASC
  `,

  countVendor: `
    SELECT COUNT(*) AS total
    FROM pm_vrm_dynamic AS pmv
    INNER JOIN master_pm AS p ON pmv.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmv.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmv.vendor_code LIKE ?)
      AND (? IS NULL OR pmv.curr_rate >= ?)
      AND (? IS NULL OR pmv.curr_rate <= ?)
      AND (? IS NULL OR pmv.effective_from >= ?)
      AND (? IS NULL OR pmv.vendor_id IN (?))
  `,

  /** Distinct PM types for the make filter dropdown. */
  selectDistinctMakes: `
    SELECT DISTINCT type AS make FROM master_pm
    WHERE type IS NOT NULL AND type != ''
    ORDER BY type ASC
  `,

  /**
   * Build the filter parameter array for vendor-rate queries.
   * Centralises the repeated-param pattern so callers never have to count.
   *
   * Usage:
   *   const fp = packingMaterials.vendorFilterParams(search, status, make, vendorCode, rateMin, rateMax, effectiveFrom)
   *   paginate(packingMaterials.selectVendorPaginated, [...fp, limit, offset], packingMaterials.countVendor, fp, ...)
   */
  vendorFilterParams(
    search: string | null,
    status: string | null,
    make: string | null,
    vendorCode: string | null,
    rateMin: string | null,
    rateMax: string | null,
    effectiveFrom: string | null,
    scope: UserScope,
  ): unknown[] {
    const like   = search     ? `%${search}%`     : null
    const vcLike = vendorCode ? `%${vendorCode}%` : null
    const rateMinNum = rateMin ? Number(rateMin) : null
    const rateMaxNum = rateMax ? Number(rateMax) : null
    return [
      like, like, like,
      status, status,
      make, make,
      vcLike, vcLike,
      rateMinNum, rateMinNum,
      rateMaxNum, rateMaxNum,
      effectiveFrom, effectiveFrom,
      ...scopeParams(scope.vendorIds),
    ]
  },

  /**
   * Paginated PM × manufacturer rates with optional filters.
   * Params: mfgFilterParams(...) + [LIMIT, OFFSET]  (13 + 2 = 15 total)
   */
  selectMfgPaginated: `
    SELECT
      p.pm_code, p.name, p.type, p.pantone_color,
      p.hsn_code, p.uom, pmm.pm_id, pmm.id AS rate_id,
      pmm.mfg_id, pmm.mfg_code, pmm.curr_rate,
      pmm.uom, pmm.status, pmm.effective_from
    FROM pm_mrm_fixed AS pmm
    INNER JOIN master_pm AS p ON pmm.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmm.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmm.mfg_code LIKE ?)
      AND (? IS NULL OR pmm.curr_rate >= ?)
      AND (? IS NULL OR pmm.curr_rate <= ?)
      AND (? IS NULL OR pmm.effective_from >= ?)
      AND (? IS NULL OR pmm.mfg_id IN (?))
    ORDER BY p.pm_code ASC
    LIMIT ? OFFSET ?
  `,

  selectMfgAllFiltered: `
    SELECT
      p.pm_code, p.name, p.type, p.pantone_color,
      p.hsn_code, p.uom, pmm.pm_id, pmm.id AS rate_id,
      pmm.mfg_id, pmm.mfg_code, pmm.curr_rate,
      pmm.uom, pmm.status, pmm.effective_from
    FROM pm_mrm_fixed AS pmm
    INNER JOIN master_pm AS p ON pmm.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmm.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmm.mfg_code LIKE ?)
      AND (? IS NULL OR pmm.curr_rate >= ?)
      AND (? IS NULL OR pmm.curr_rate <= ?)
      AND (? IS NULL OR pmm.effective_from >= ?)
      AND (? IS NULL OR pmm.mfg_id IN (?))
    ORDER BY p.pm_code ASC
  `,

  countMfg: `
    SELECT COUNT(*) AS total
    FROM pm_mrm_fixed AS pmm
    INNER JOIN master_pm AS p ON pmm.pm_id = p.id
    WHERE (? IS NULL OR p.pm_code LIKE ? OR p.name LIKE ?)
      AND (? IS NULL OR pmm.status = ?)
      AND (? IS NULL OR p.type = ?)
      AND (? IS NULL OR pmm.mfg_code LIKE ?)
      AND (? IS NULL OR pmm.curr_rate >= ?)
      AND (? IS NULL OR pmm.curr_rate <= ?)
      AND (? IS NULL OR pmm.effective_from >= ?)
      AND (? IS NULL OR pmm.mfg_id IN (?))
  `,

  /** Build the filter param array for all mfg-view queries. */
  mfgFilterParams(
    search: string | null,
    status: string | null,
    type: string | null,
    mfgCode: string | null,
    rateMin: string | null,
    rateMax: string | null,
    effectiveFrom: string | null,
    scope: UserScope,
  ): unknown[] {
    const like       = search   ? `%${search}%`   : null
    const mfgLike    = mfgCode  ? `%${mfgCode}%`  : null
    const rateMinNum = rateMin  ? Number(rateMin)  : null
    const rateMaxNum = rateMax  ? Number(rateMax)  : null
    return [
      like, like, like,
      status, status,
      type, type,
      mfgLike, mfgLike,
      rateMinNum, rateMinNum,
      rateMaxNum, rateMaxNum,
      effectiveFrom, effectiveFrom,
      ...scopeParams(scope.mfgIds),
    ]
  },

  // ============ INSERT QUERIES ============

  /** Insert a packing material base record. Parameters: [pm_code, name, type, hsn_code, uom, status, pantone_color] */
  insert: `
    INSERT INTO master_pm (pm_code, name, type, hsn_code, uom, status, pantone_color)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,

  /** Parameters: [pm_id, vendor_id, vendor_code, curr_rate, moq, uom, status, effective_from, effective_to] */
  insertVendorRate: `
    INSERT INTO pm_vrm_dynamic (pm_id, vendor_id, vendor_code, curr_rate, moq, uom, status, effective_from, effective_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Parameters: [pm_id, mfg_id, mfg_code, curr_rate, uom, status, effective_from] */
  insertMfgRate: `
    INSERT INTO pm_mrm_fixed (pm_id, mfg_id, mfg_code, curr_rate, uom, status, effective_from)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,

  /** Check if a PM already exists by name + type. Parameters: [name, type] */
  checkDuplicate: `
    SELECT id, pm_code FROM master_pm WHERE name = ? AND type = ? LIMIT 1
  `,

  /** Total PM count — used to auto-generate the next pm_code (PM<serial>). */
  countTotal: `SELECT COUNT(*) AS total FROM master_pm`,

  /**
   * Check if a vendor rate exists for this pm + vendor + MOQ combination.
   * MOQ is part of the key so the same vendor can hold multiple rate rows —
   * one per MOQ slab.
   * Parameters: [pm_id, vendor_id, moq]
   */
  checkVendorRate: `
    SELECT id, vendor_id, curr_rate, moq, uom, status, effective_from, effective_to
    FROM pm_vrm_dynamic WHERE pm_id = ? AND vendor_id = ? AND moq = ? LIMIT 1
  `,

  /** Archive an old pm_vrm row to vrm_history. Parameters: [pm_id, vendor_id, curr_rate, moq, uom, effective_from, effective_to, status] */
  archiveVendorRate: `
    INSERT INTO history_vrm (mtrl_type, mtrl_id, vendor_id, rate, moq, uom, effective_from, effective_to, status)
    VALUES ('pm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Update an existing pm_vrm row. Parameters: [curr_rate, moq, uom, status, effective_from, id] */
  updateVendorRate: `
    UPDATE pm_vrm_dynamic SET curr_rate = ?, moq = ?, uom = ?, status = ?, effective_from = ?, effective_to = NULL, updated_on = NOW()
    WHERE id = ?
  `,

  /** Check if a manufacturer rate exists for this pm + mfg. Parameters: [pm_id, mfg_id] */
  checkMfgRate: `
    SELECT id, mfg_id, curr_rate, uom, status, effective_from FROM pm_mrm_fixed WHERE pm_id = ? AND mfg_id = ? LIMIT 1
  `,

  /** Update an existing pm_mrm approval row in place. Parameters: [curr_rate, uom, effective_from, id] */
  updateMfgRate: `
    UPDATE pm_mrm_fixed SET curr_rate = ?, uom = ?, effective_from = ?, updated_on = NOW() WHERE id = ?
  `,

  /** Insert a minimal pm_mrm approval row (curr_rate = 0, rates filled later). Parameters: [pm_id, mfg_id, mfg_code, effective_from] */
  insertMfgApproval: `
    INSERT INTO pm_mrm_fixed (pm_id, mfg_id, mfg_code, curr_rate, uom, status, effective_from)
    VALUES (?, ?, ?, 0, NULL, 'active', ?)
  `,

  /** Archive old PM vendor rate to history_vrm before overwriting.
   *  Parameters: [mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by]
   */
  archiveToHistoryVrm: `
    INSERT INTO history_vrm (mtrl_type, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by)
    VALUES ('pm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Archive old PM mfg rate to history_mrm before overwriting.
   *  Parameters: [mfg_id, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by]
   */
  archiveToHistoryMrm: `
    INSERT INTO history_mrm (mfg_id, mtrl_type, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by)
    VALUES (?, 'pm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Find the first vendor_id linked to a PM in the vendor rate master. Parameters: [pm_id] */
  getVendorId: `
    SELECT vendor_id FROM pm_vrm_dynamic WHERE pm_id = ? AND vendor_id IS NOT NULL LIMIT 1
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Set status on a pm_mrm_fixed rate row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setRateStatus: `UPDATE pm_mrm_fixed SET status = ? WHERE id = ?`,

  /** Fetch a single pm_mrm_fixed rate row by its primary key.
   *  Used by the approve handler to read current values before archiving.
   *  Parameters: [id]
   */
  selectRateById: `
    SELECT id, mfg_id, pm_id, curr_rate, uom, effective_from, status
    FROM pm_mrm_fixed WHERE id = ? LIMIT 1
  `,

  // ── Base-record approval-flow helpers ───────────────────────────────────────

  /** Fetch a single master_pm row by its primary key.
   *  Used by the approve handler to read current values before applying changes.
   *  Parameters: [id]
   */
  selectBaseById: `
    SELECT id, pm_code, name, type, uom, status, hsn_code, pantone_color
    FROM master_pm WHERE id = ? LIMIT 1
  `,

  /** Full-row lookup by business code, for bulk-CSV edit detection — `code`
   *  aliases pm_code so this satisfies the generic EditCandidate shape used
   *  by lib/master-routes/edit-match.ts. Parameters: [pm_code] */
  selectByCodeForMatch: `
    SELECT id, pm_code, pm_code AS code, name, type, uom, status, hsn_code, pantone_color
    FROM master_pm WHERE pm_code = ? LIMIT 1
  `,

  /** IN (?)-batched counterpart of selectByCodeForMatch, for the whole
   *  uploaded file at once — see fetchEditMatchCandidates. Parameters: [codes[]] */
  selectCandidatesByCodesBatch: `
    SELECT id, pm_code, pm_code AS code, name, type, uom, status, hsn_code, pantone_color
    FROM master_pm WHERE pm_code IN (?)
  `,

  /** Set status on a master_pm base record (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setBaseStatus: `UPDATE master_pm SET status = ? WHERE id = ?`,

  // ── VRM Approval-flow helpers ─────────────────────────────────────────────

  /** Set status on a pm_vrm_dynamic row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setVendorRateStatus: `UPDATE pm_vrm_dynamic SET status = ? WHERE id = ?`,

  /** Fetch a single pm_vrm_dynamic row by its primary key.
   *  Parameters: [id]
   */
  selectVendorRateById: `
    SELECT id, pm_id, vendor_id, curr_rate, moq, uom, effective_from, effective_to, status
    FROM pm_vrm_dynamic WHERE id = ? LIMIT 1
  `,

  /** Full archived rate history for one PM×Vendor pair from history_vrm, newest first.
   *  Parameters: [pm_id, vendor_id]
   */
  selectVendorRateHistory: `
    SELECT h.id, h.rate, h.effective_from, h.effective_to, h.updated_on, h.status, h.remarks,
           u.name AS changed_by_name
    FROM history_vrm h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mtrl_type = 'pm' AND h.mtrl_id = ? AND h.vendor_id = ?
    ORDER BY h.updated_on DESC, h.id DESC
  `,

  /** Full archived rate history for one PM×Manufacturer pair from history_mrm, newest first.
   *  Parameters: [pm_id, mfg_id]
   */
  selectMfgRateHistory: `
    SELECT h.id, h.rate, h.effective_from, h.effective_to, h.updated_on, h.status, h.remarks,
           u.name AS changed_by_name
    FROM history_mrm h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mtrl_type = 'pm' AND h.mtrl_id = ? AND h.mfg_id = ?
    ORDER BY h.updated_on DESC, h.id DESC
  `,
}