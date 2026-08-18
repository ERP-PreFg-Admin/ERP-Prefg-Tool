/**
 * Raw Materials (RM) Queries
 * Centralized queries for raw materials table and related tables (rm_mrm, rm_vrm)
 */

import { scopeParams, type UserScope } from "@/lib/scope"
import { SQL_TODAY_IST } from "@/lib/date"

/**
 * Brand scope for a MATERIAL, which has no brand of its own.
 *
 * A material is visible when it appears in a recipe for one of your brands, OR
 * when it appears in no brand-attributed recipe at all. That second arm is not a
 * loophole — it is what keeps a newly added material visible on the very page you
 * would add it from, and it matches the `brand_id IS NULL` allowance every other
 * predicate makes.
 *
 * Back-derivation is deliberately many-to-many: one RM legitimately serves
 * several brands, so this is EXISTS rather than a join — a join would multiply
 * the material row once per recipe that uses it.
 *
 * Rate rows (cost_master_*) carry NO predicate of their own; they inherit
 * visibility through their material.
 *
 * `mtrl_type` is lowercase 'rm'/'pm' in details_recipe — see
 * lib/queries/manufacturing.ts:358.
 *
 * Params: [flag, brandIds] — 2 values, from scopeParams(scope.brandIds).
 */
const brandScopeFor = (mtrlType: "rm" | "pm", idColumn: string) => `
    AND (? IS NULL
         OR EXISTS (
           SELECT 1 FROM details_recipe dr
           JOIN master_recipe mr ON mr.id = dr.recipe_id
           JOIN master_skus  ms ON ms.id = mr.sku_id
           WHERE dr.mtrl_type = '${mtrlType}' AND dr.mtrl_id = ${idColumn}
             AND ms.brand_id IN (?)
         )
         OR NOT EXISTS (
           SELECT 1 FROM details_recipe dr
           JOIN master_recipe mr ON mr.id = dr.recipe_id
           JOIN master_skus  ms ON ms.id = mr.sku_id
           WHERE dr.mtrl_type = '${mtrlType}' AND dr.mtrl_id = ${idColumn}
             AND ms.brand_id IS NOT NULL
         ))`

export const rawMaterials = {
  // ============ SELECT QUERIES ============

  /** Get all raw materials (base data only, no rate joins) */
  selectAll: `
    SELECT id, rm_code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm ORDER BY name
  `,

  /** Active raw materials only — used to populate the Recipe wizard's RM picker. */
  selectActive: `
    SELECT id, rm_code, name, uom, status
    FROM master_rm
    WHERE status = 'active'
    ORDER BY name
  `,

  /** Active raw materials with every field the cost-master "Add Rates" wizard
   *  needs to display once a material is picked (make/type/inci_name too). */
  selectActiveFull: `
    SELECT id, rm_code, name, make, type, uom, hsn_code, inci_name
    FROM master_rm
    WHERE status = 'active'
    ORDER BY name
  `,

  /**
   * Get all raw materials grouped by manufacturer
   * Used in RawMaterialsPage manufacturer view
   */
  selectByManufacturer: `
    SELECT rmm.rm_id, rmm.mfg_id, rmm.mfg_code, rmm.approved_vendor_id, rmm.approved_vendor_code,
      rmm.curr_rate, rmm.effective_from, rmm.uom, r.status,
      rmm.status AS rate_status,
      r.id, r.name, r.make, r.type, r.hsn_code, r.rm_code, r.inci_name
    FROM cost_master_rm_mfg AS rmm
    INNER JOIN master_rm AS r ON r.id = rmm.rm_id
  `,

  /**
   * Get all raw materials grouped by vendor
   * Used in RawMaterialsPage vendor view
   */
  selectByVendor: `
    SELECT
      r.hsn_code, r.inci_name, r.make, r.name, r.rm_code, r.status, r.type,
      rmv.id AS vrm_id, rmv.status AS vrm_status,
      rmv.curr_rate, rmv.effective_from, rmv.effective_to,
      rmv.moq, rmv.uom, rmv.vendor_code, rmv.vendor_id
    FROM cost_master_rm_ven AS rmv
    INNER JOIN master_rm AS r ON r.id = rmv.rm_id
  `,

  /** Select a raw material by its code for bulk import purposes. Parameters: [rm_code] */
  selectByCode: `SELECT id, uom, status FROM master_rm WHERE rm_code = ? LIMIT 1`,

  /**
   * Cheapest and most expensive currently-effective vendor (VRM) rate per RM,
   * across ALL vendors (not scoped to any one manufacturer — vendors aren't
   * tied to a specific mfg). Used by the Agreed Final Costing tab's
   * cheapest/max vendor-rate comparison tables. Vendor name at the min/max
   * rate is resolved via a correlated subquery (same "pick one row" pattern
   * as manufacturingSql.selectPmVendorByMfg) since MIN()/MAX() alone can't
   * say which vendor produced that extreme.
   *
   * Vendor-scoped: the clause appears THREE times — once in the aggregate and
   * once in each correlated subquery. Scoping only the aggregate would compute
   * an in-scope min/max but still resolve the NAME of an out-of-scope vendor
   * that happens to quote the same rate.
   * Params: scopeParams(vendorIds) × 3 (6 total)
   */
  selectMinMaxVrmRateByRm: `
    SELECT
      agg.rm_id, agg.min_rate, agg.max_rate,
      minv.code AS min_vendor_code, minv.name AS min_vendor_name,
      maxv.code AS max_vendor_code, maxv.name AS max_vendor_name
    FROM (
      SELECT rm_id, MIN(curr_rate) AS min_rate, MAX(curr_rate) AS max_rate
      FROM cost_master_rm_ven
      WHERE status = 'active'
        AND effective_from <= ${SQL_TODAY_IST}
        AND (effective_to IS NULL OR effective_to >= ${SQL_TODAY_IST})
        AND (? IS NULL OR vendor_id IN (?))
      GROUP BY rm_id
    ) agg
    LEFT JOIN master_vendors minv ON minv.id = (
      SELECT vendor_id FROM cost_master_rm_ven
      WHERE rm_id = agg.rm_id AND curr_rate = agg.min_rate AND status = 'active'
        AND effective_from <= ${SQL_TODAY_IST} AND (effective_to IS NULL OR effective_to >= ${SQL_TODAY_IST})
        AND (? IS NULL OR vendor_id IN (?))
      ORDER BY id LIMIT 1
    )
    LEFT JOIN master_vendors maxv ON maxv.id = (
      SELECT vendor_id FROM cost_master_rm_ven
      WHERE rm_id = agg.rm_id AND curr_rate = agg.max_rate AND status = 'active'
        AND effective_from <= ${SQL_TODAY_IST} AND (effective_to IS NULL OR effective_to >= ${SQL_TODAY_IST})
        AND (? IS NULL OR vendor_id IN (?))
      ORDER BY id LIMIT 1
    )
  `,

  // ============ PAGINATED BASE TABLE QUERIES (material-master page) ============

  /**
   * Fetch ALL matching base RM rows for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated.
   * Params: [like, like, like, like, status, status]
   */
  /**
   * Fetch ALL matching base RM rows for export.
   * Params: [like×4, status×2, make×2, type×2]
   */
  selectBaseAllFiltered: `
    SELECT id, rm_code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm
    WHERE (? IS NULL OR rm_code LIKE ? OR name LIKE ? OR make LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR make = ?)
      AND (? IS NULL OR type = ?)
      ${brandScopeFor("rm", "master_rm.id")}
    ORDER BY name ASC
  `,

  /**
   * Paginated base RM list with optional search + status + make + type filter.
   * Params: [like×4, status×2, make×2, type×2, LIMIT, OFFSET]
   */
  selectPaginated: `
    SELECT id, rm_code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm
    WHERE (? IS NULL OR rm_code LIKE ? OR name LIKE ? OR make LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR make = ?)
      AND (? IS NULL OR type = ?)
      ${brandScopeFor("rm", "master_rm.id")}
    ORDER BY name ASC
    LIMIT ? OFFSET ?
  `,

  /** Matching COUNT for selectPaginated. Params: [like×4, status×2, make×2, type×2] */
  countAll: `
    SELECT COUNT(*) AS total FROM master_rm
    WHERE (? IS NULL OR rm_code LIKE ? OR name LIKE ? OR make LIKE ?)
      AND (? IS NULL OR status = ?)
      AND (? IS NULL OR make = ?)
      AND (? IS NULL OR type = ?)
      ${brandScopeFor("rm", "master_rm.id")}
  `,

  /**
   * Update RM base record fields (rm_code is auto-generated, never changed).
   * Params: [name, make, type, uom, status, hsn_code, inci_name, id]
   */
  update: `
    UPDATE master_rm
    SET name = ?, make = ?, type = ?, uom = ?, status = ?, hsn_code = ?, inci_name = ?
    WHERE id = ?
  `,

  // ============ PAGINATED SELECT QUERIES (raw-materials rate page) ============

  /**
   * Paginated RM × vendor rates with optional search + status + make + vendor_code
   * + rate_min/max + effective_from filter.
   * Params: vendorFilterParams(...) + [LIMIT, OFFSET]
   *   [like×3, status×2, make×2, vcLike×2, rateMin×2, rateMax×2, effFrom×2, LIMIT, OFFSET]
   */
  selectVendorPaginated: `
    SELECT
      r.hsn_code, r.inci_name, r.make, r.name, r.rm_code, r.status, r.type,
      rmv.rm_id, rmv.id AS vrm_id, rmv.status AS vrm_status,
      rmv.curr_rate, rmv.effective_from, rmv.effective_to,
      rmv.moq, rmv.uom, rmv.vendor_code, rmv.vendor_id,
      rmv.mfg_id, mm.name AS mfg_name, mm.code AS mfg_code
    FROM cost_master_rm_ven AS rmv
    INNER JOIN master_rm AS r ON r.id = rmv.rm_id
    LEFT JOIN master_mfgs AS mm ON mm.id = rmv.mfg_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.make = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmv.vendor_code LIKE ?)
      AND (? IS NULL OR rmv.curr_rate >= ?)
      AND (? IS NULL OR rmv.curr_rate <= ?)
      AND (? IS NULL OR rmv.effective_from >= ?)
      AND (? IS NULL OR rmv.vendor_id IN (?))
    ORDER BY r.rm_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching RM × vendor rate rows for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectVendorPaginated.
   * Params: vendorFilterParams(...)
   */
  selectVendorAllFiltered: `
    SELECT
      r.hsn_code, r.inci_name, r.make, r.name, r.rm_code, r.status, r.type,
      rmv.rm_id, rmv.id AS vrm_id, rmv.status AS vrm_status,
      rmv.curr_rate, rmv.effective_from, rmv.effective_to,
      rmv.moq, rmv.uom, rmv.vendor_code, rmv.vendor_id,
      rmv.mfg_id, mm.name AS mfg_name, mm.code AS mfg_code
    FROM cost_master_rm_ven AS rmv
    INNER JOIN master_rm AS r ON r.id = rmv.rm_id
    LEFT JOIN master_mfgs AS mm ON mm.id = rmv.mfg_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.make = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmv.vendor_code LIKE ?)
      AND (? IS NULL OR rmv.curr_rate >= ?)
      AND (? IS NULL OR rmv.curr_rate <= ?)
      AND (? IS NULL OR rmv.effective_from >= ?)
      AND (? IS NULL OR rmv.vendor_id IN (?))
    ORDER BY r.rm_code ASC
  `,

  /**
   * Matching COUNT for selectVendorPaginated.
   * Params: vendorFilterParams(...)
   */
  countVendor: `
    SELECT COUNT(*) AS total
    FROM cost_master_rm_ven AS rmv
    INNER JOIN master_rm AS r ON r.id = rmv.rm_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.make = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmv.vendor_code LIKE ?)
      AND (? IS NULL OR rmv.curr_rate >= ?)
      AND (? IS NULL OR rmv.curr_rate <= ?)
      AND (? IS NULL OR rmv.effective_from >= ?)
      AND (? IS NULL OR rmv.vendor_id IN (?))
  `,

  /** Distinct RM makes for the make filter dropdown. */
  selectDistinctMakes: `
    SELECT DISTINCT make FROM master_rm
    WHERE make IS NOT NULL AND make != ''
    ORDER BY make ASC
  `,

  /** Distinct RM types for the type filter dropdown. */
  selectDistinctTypes: `
    SELECT DISTINCT type FROM master_rm
    WHERE type IS NOT NULL AND type != ''
    ORDER BY type ASC
  `,

  /** Distinct INCI names for the managed dropdown in add/edit forms. */
  selectDistinctInciNames: `
    SELECT DISTINCT inci_name FROM master_rm
    WHERE inci_name IS NOT NULL AND inci_name != ''
    ORDER BY inci_name ASC
  `,

  /**
   * Distinct makes already used for the same name + type combination —
   * fuzzy-matched client-side (Fuse.js) against a newly typed make to catch
   * typos ("addni" vs "Adani"). Scoped to name+type so unrelated materials
   * that legitimately share a make don't cross-pollute suggestions.
   * Parameters: [name, type]
   */
  selectMakesByNameType: `
    SELECT DISTINCT make FROM master_rm
    WHERE LOWER(name) = LOWER(?) AND LOWER(IFNULL(type,'')) = LOWER(IFNULL(?,''))
      AND make IS NOT NULL AND make != ''
  `,

  /**
   * Build the filter parameter array for vendor-rate queries.
   * Centralises the repeated-param pattern so callers never have to count.
   */
  vendorFilterParams(
    search: string | null,
    status: string | null,
    make: string | null,
    type: string | null,
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
      type, type,
      vcLike, vcLike,
      rateMinNum, rateMinNum,
      rateMaxNum, rateMaxNum,
      effectiveFrom, effectiveFrom,
      ...scopeParams(scope.vendorIds),
    ]
  },

  /**
   * Paginated RM × manufacturer rates with optional filters.
   * Params: mfgFilterParams(...) + [LIMIT, OFFSET]  (13 + 2 = 15 total)
   */
  selectMfgPaginated: `
    SELECT
      rmm.id AS rate_id,
      rmm.rm_id, rmm.mfg_id, rmm.mfg_code, rmm.approved_vendor_id, rmm.approved_vendor_code,
      rmm.curr_rate, rmm.effective_from, rmm.uom, r.status,
      rmm.status AS rate_status,
      r.id, r.name, r.make, r.type, r.hsn_code, r.rm_code, r.inci_name
    FROM cost_master_rm_mfg AS rmm
    INNER JOIN master_rm AS r ON r.id = rmm.rm_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmm.mfg_code LIKE ?)
      AND (? IS NULL OR rmm.curr_rate >= ?)
      AND (? IS NULL OR rmm.curr_rate <= ?)
      AND (? IS NULL OR rmm.effective_from >= ?)
      AND (? IS NULL OR rmm.mfg_id IN (?))
    ORDER BY r.rm_code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching RM × manufacturer rate rows for export (no LIMIT/OFFSET).
   * Params: mfgFilterParams(...)
   */
  selectMfgAllFiltered: `
    SELECT
      rmm.id AS rate_id,
      rmm.rm_id, rmm.mfg_id, rmm.mfg_code, rmm.approved_vendor_id, rmm.approved_vendor_code,
      rmm.curr_rate, rmm.effective_from, rmm.uom, r.status,
      rmm.status AS rate_status,
      r.id, r.name, r.make, r.type, r.hsn_code, r.rm_code, r.inci_name
    FROM cost_master_rm_mfg AS rmm
    INNER JOIN master_rm AS r ON r.id = rmm.rm_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmm.mfg_code LIKE ?)
      AND (? IS NULL OR rmm.curr_rate >= ?)
      AND (? IS NULL OR rmm.curr_rate <= ?)
      AND (? IS NULL OR rmm.effective_from >= ?)
      AND (? IS NULL OR rmm.mfg_id IN (?))
    ORDER BY r.rm_code ASC
  `,

  /** Matching COUNT for selectMfgPaginated. Params: mfgFilterParams(...) */
  countMfg: `
    SELECT COUNT(*) AS total
    FROM cost_master_rm_mfg AS rmm
    INNER JOIN master_rm AS r ON r.id = rmm.rm_id
    WHERE (? IS NULL OR r.rm_code LIKE ? OR r.name LIKE ?)
      AND (? IS NULL OR r.status = ?)
      AND (? IS NULL OR r.type = ?)
      AND (? IS NULL OR rmm.mfg_code LIKE ?)
      AND (? IS NULL OR rmm.curr_rate >= ?)
      AND (? IS NULL OR rmm.curr_rate <= ?)
      AND (? IS NULL OR rmm.effective_from >= ?)
      AND (? IS NULL OR rmm.mfg_id IN (?))
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

  /**
   * Insert a single raw material record
   * Parameters: [rm_code, name, make, type, uom, status, hsn_code, inci_name]
   */
  insert: `
    INSERT INTO master_rm (rm_code, name, make, type, uom, status, hsn_code, inci_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Insert a vendor rate record for a raw material. `mfg_id` is an optional,
   * informational tag — "this vendor supplies this material to that
   * manufacturer" — it does not create a separate cost_master_rm_mfg row.
   * Parameters: [rm_id, vendor_id, vendor_code, curr_rate, moq, uom, effective_from, effective_to, status, mfg_id]
   */
  insertVendorRate: `
    INSERT INTO cost_master_rm_ven (rm_id, vendor_id, vendor_code, curr_rate, moq, uom, effective_from, effective_to, status, mfg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Insert a manufacturer rate record for a raw material
   * Parameters: [rm_id, mfg_id, mfg_code, curr_rate, uom, approved_vendor_id, approved_vendor_code, effective_from]
   */
  insertMfgRate: `
    INSERT INTO cost_master_rm_mfg (rm_id, mfg_id, mfg_code, curr_rate, uom, approved_vendor_id, approved_vendor_code, effective_from, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Check if an RM already exists by name + make + inci_name (case-insensitive).
   * Parameters: [name, make, inci_name]
   */
  checkDuplicate: `
    SELECT id FROM master_rm
    WHERE LOWER(name) = LOWER(?) AND LOWER(IFNULL(make,'')) = LOWER(?) AND LOWER(IFNULL(inci_name,'')) = LOWER(?)
  `,

  /** Total RM count — used to auto-generate the next rm_code (RM<serial>). */
  countTotal: `SELECT COUNT(*) AS total FROM master_rm`,

  /**
   * Insert a minimal manufacturer approval row (no rate data yet)
   * Parameters: [rm_id, mfg_id, mfg_code]
   */
  insertMfgApproval: `
    INSERT INTO cost_master_rm_mfg (rm_id, mfg_id, mfg_code, curr_rate, status)
    VALUES (?, ?, ?, 0, 'active')
  `,

  /**
   * Check if a vendor rate already exists for this rm + vendor + MOQ combination.
   * MOQ is part of the key so the same vendor can hold multiple rate rows —
   * one per MOQ slab.
   * Parameters: [rm_id, vendor_id, moq]
   */
  checkVendorRate: `
    SELECT id, vendor_id, curr_rate, moq, uom, effective_from, effective_to, status, mfg_id
    FROM cost_master_rm_ven WHERE rm_id = ? AND vendor_id = ? AND moq = ? LIMIT 1
  `,

  /**
   * Archive an old rm_vrm row into vrm_history before overwriting it.
   * Parameters: [rm_id, vendor_id, curr_rate, moq, uom, effective_from, effective_to, status]
   */
  archiveVendorRate: `
    INSERT INTO history_cost_ven (mtrl_type, mtrl_id, vendor_id, rate, moq, uom, effective_from, effective_to, status)
    VALUES ('rm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Update an existing rm_vrm row with new pricing (clears effective_to).
   * Parameters: [curr_rate, moq, uom, effective_from, id]
   */
  updateVendorRate: `
    UPDATE cost_master_rm_ven
    SET curr_rate = ?, moq = ?, uom = ?, effective_from = ?, effective_to = NULL, updated_on = NOW(), mfg_id = ?
    WHERE id = ?
  `,

  /** Archive old RM vendor rate to history_cost_ven before overwriting.
   *  Parameters: [mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by]
   */
  archiveToHistoryVrm: `
    INSERT INTO history_cost_ven (mtrl_type, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by)
    VALUES ('rm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Check if a mfg rate already exists for this rm + mfg combination.
   *  Parameters: [rm_id, mfg_id]
   */
  checkMfgRate: `
    SELECT id, mfg_id, curr_rate, uom, approved_vendor_id, effective_from, status
    FROM cost_master_rm_mfg WHERE rm_id = ? AND mfg_id = ? LIMIT 1
  `,

  /** Update an existing rm_mrm row with new rate data.
   *  Parameters: [curr_rate, uom, effective_from, id]
   */
  updateMfgRate: `
    UPDATE cost_master_rm_mfg SET curr_rate = ?, uom = ?, effective_from = ?, updated_on = NOW() WHERE id = ?
  `,

  /** Archive old RM mfg rate to history_cost_mfg before overwriting.
   *  Parameters: [mfg_id, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by]
   */
  archiveToHistoryMrm: `
    INSERT INTO history_cost_mfg (mfg_id, mtrl_type, mtrl_id, vendor_id, rate, effective_from, effective_to, status, remarks, changed_by)
    VALUES (?, 'rm', ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** Find the first vendor_id linked to an RM in the vendor rate master. Parameters: [rm_id] */
  getVendorId: `
    SELECT vendor_id FROM cost_master_rm_ven WHERE rm_id = ? AND vendor_id IS NOT NULL LIMIT 1
  `,

  // ── Base-record approval-flow helpers ───────────────────────────────────────

  /** Fetch a single master_rm row by its primary key.
   *  Used by the approve handler to read current values before applying changes.
   *  Parameters: [id]
   */
  selectBaseById: `
    SELECT id, rm_code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm WHERE id = ? LIMIT 1
  `,

  /** Set status on a master_rm base record (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setBaseStatus: `UPDATE master_rm SET status = ? WHERE id = ?`,

  /** Full-row lookup by business code, for bulk-CSV edit detection — `code`
   *  aliases rm_code so this satisfies the generic EditCandidate shape used
   *  by lib/master-routes/edit-match.ts. Parameters: [rm_code] */
  selectByCodeForMatch: `
    SELECT id, rm_code, rm_code AS code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm WHERE rm_code = ? LIMIT 1
  `,

  /** IN (?)-batched counterpart of selectByCodeForMatch, for the whole
   *  uploaded file at once — see fetchEditMatchCandidates. Parameters: [codes[]] */
  selectCandidatesByCodesBatch: `
    SELECT id, rm_code, rm_code AS code, name, make, type, uom, status, hsn_code, inci_name
    FROM master_rm WHERE rm_code IN (?)
  `,

  // ── VRM Approval-flow helpers ─────────────────────────────────────────────

  /** Set status on a cost_master_rm_ven row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setVendorRateStatus: `UPDATE cost_master_rm_ven SET status = ? WHERE id = ?`,

  /** Fetch a single cost_master_rm_ven row by its primary key.
   *  Parameters: [id]
   */
  selectVendorRateById: `
    SELECT id, rm_id, vendor_id, curr_rate, moq, uom, effective_from, effective_to, status, mfg_id
    FROM cost_master_rm_ven WHERE id = ? LIMIT 1
  `,

  /** Full archived rate history for one RM×Vendor pair from history_cost_ven, newest first.
   *  Parameters: [rm_id, vendor_id]
   */
  selectVendorRateHistory: `
    SELECT h.id, h.rate, h.effective_from, h.effective_to, h.updated_on, h.status, h.remarks,
           u.name AS changed_by_name
    FROM history_cost_ven h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mtrl_type = 'rm' AND h.mtrl_id = ? AND h.vendor_id = ?
    ORDER BY h.updated_on DESC, h.id DESC
  `,

  /** Full archived rate history for one RM×Manufacturer pair from history_cost_mfg, newest first.
   *  Parameters: [rm_id, mfg_id]
   */
  selectMfgRateHistory: `
    SELECT h.id, h.rate, h.effective_from, h.effective_to, h.updated_on, h.status, h.remarks,
           u.name AS changed_by_name
    FROM history_cost_mfg h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.mtrl_type = 'rm' AND h.mtrl_id = ? AND h.mfg_id = ?
    ORDER BY h.updated_on DESC, h.id DESC
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Set status on a cost_master_rm_mfg rate row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, id]
   */
  setRateStatus: `UPDATE cost_master_rm_mfg SET status = ? WHERE id = ?`,

  /** Fetch a single cost_master_rm_mfg rate row by its primary key.
   *  Used by the approve handler to read current values before archiving.
   *  Parameters: [id]
   */
  selectRateById: `
    SELECT id, mfg_id, rm_id, curr_rate, uom, approved_vendor_id, effective_from, status
    FROM cost_master_rm_mfg WHERE id = ? LIMIT 1
  `,
}
