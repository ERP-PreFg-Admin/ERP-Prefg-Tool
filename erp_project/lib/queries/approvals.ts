/**
 * Approval Workflow Queries
 *
 * Raw-SQL strings consumed by the approvals API routes via
 * query() / execute() / pool.getConnection() from lib/db.ts.
 *
 * The `approvals` table tracks who submitted an edit and its current state.
 * The `approval_items` table stores a field-level diff (old_value / new_value)
 * for each changed field within one approval.
 */

/**
 * Per-module SQL to fetch the human-readable label for the entity being approved.
 * Each query returns: { code, name, secondary_code?, secondary_name? }
 * Parameters: [entity_id]
 */
export const entityLabelSql: Record<string, string> = {
  SKU: `
    SELECT sku_code AS code, name, NULL AS secondary_code, NULL AS secondary_name
    FROM master_skus WHERE id = ? LIMIT 1
  `,
  RM_MAT: `
    SELECT COALESCE(rm_code, CONCAT('RM#', id)) AS code, name, NULL AS secondary_code, NULL AS secondary_name
    FROM master_rm WHERE id = ? LIMIT 1
  `,
  PM_MAT: `
    SELECT COALESCE(pm_code, CONCAT('PM#', id)) AS code, name, NULL AS secondary_code, NULL AS secondary_name
    FROM master_pm WHERE id = ? LIMIT 1
  `,
  VENDOR: `
    SELECT v.code, v.name, NULL AS secondary_code, NULL AS secondary_name
    FROM master_vendors v WHERE v.id = ? LIMIT 1
  `,
  MFG: `
    SELECT code, name, NULL AS secondary_code, NULL AS secondary_name
    FROM master_mfgs WHERE id = ? LIMIT 1
  `,
  RM_RATE: `
    SELECT r.rm_code AS code, r.name, m.code AS secondary_code, m.name AS secondary_name
    FROM cost_master_rm_mfg rmm
    JOIN master_rm r ON r.id = rmm.rm_id
    JOIN master_mfgs m ON m.id = rmm.mfg_id
    WHERE rmm.id = ? LIMIT 1
  `,
  PM_RATE: `
    SELECT p.pm_code AS code, p.name, m.code AS secondary_code, m.name AS secondary_name
    FROM cost_master_pm_mfg pmm
    JOIN master_pm p ON p.id = pmm.pm_id
    JOIN master_mfgs m ON m.id = pmm.mfg_id
    WHERE pmm.id = ? LIMIT 1
  `,
  RM_VRM: `
    SELECT r.rm_code AS code, r.name, v.code AS secondary_code, v.name AS secondary_name
    FROM cost_master_rm_ven rmv
    JOIN master_rm r ON r.id = rmv.rm_id
    JOIN master_vendors v ON v.id = rmv.vendor_id
    WHERE rmv.id = ? LIMIT 1
  `,
  PM_VRM: `
    SELECT p.pm_code AS code, p.name, v.code AS secondary_code, v.name AS secondary_name
    FROM cost_master_pm_ven pmv
    JOIN master_pm p ON p.id = pmv.pm_id
    JOIN master_vendors v ON v.id = pmv.vendor_id
    WHERE pmv.id = ? LIMIT 1
  `,
  PO: `
    SELECT po.po_no AS code, m.name AS name, po.sku_code AS secondary_code, NULL AS secondary_name
    FROM purchase_orders po
    JOIN master_mfgs m ON m.id = po.mfg_id
    WHERE po.id = ? LIMIT 1
  `,
  PO_BULK: `
    SELECT u.name AS code, NULL AS name, NULL AS secondary_code, NULL AS secondary_name
    FROM users u WHERE u.id = ? LIMIT 1
  `,
  VENDOR_BULK: `
    SELECT u.name AS code, NULL AS name, NULL AS secondary_code, NULL AS secondary_name
    FROM users u WHERE u.id = ? LIMIT 1
  `,
  MFG_BULK: `
    SELECT u.name AS code, NULL AS name, NULL AS secondary_code, NULL AS secondary_name
    FROM users u WHERE u.id = ? LIMIT 1
  `,
  RM_BULK: `
    SELECT u.name AS code, NULL AS name, NULL AS secondary_code, NULL AS secondary_name
    FROM users u WHERE u.id = ? LIMIT 1
  `,
  PM_BULK: `
    SELECT u.name AS code, NULL AS name, NULL AS secondary_code, NULL AS secondary_name
    FROM users u WHERE u.id = ? LIMIT 1
  `,
  BOM: `
    SELECT b.bom_code AS code, s.sku_code AS name, NULL AS secondary_code, s.name AS secondary_name
    FROM master_recipe b
    LEFT JOIN master_skus s ON s.id = b.sku_id
    WHERE b.id = ? LIMIT 1
  `,
}

export const approvalsSql = {
  // ── Write ───────────────────────────────────────────────────────────────

  /** Create a parent approval record. Caller reads insertId for the new ID.
   *  Parameters: [raised_by, module, entity_id, approval_type]
   *  approval_type is "create" for a brand-new record/rate, "edit" for a
   *  change to an existing one — callers must pass the right one explicitly.
   */
  insertApproval: `
    INSERT INTO approvals (raised_by, module, entity_id, approval_type, status)
    VALUES (?, ?, ?, ?, 'pending')
  `,

  /** Insert one approval_items row per changed field.
   *  Parameters: [approval_id, field_name, old_value, new_value]
   */
  insertApprovalItem: `
    INSERT INTO approval_items (approval_id, field_name, old_value, new_value)
    VALUES (?, ?, ?, ?)
  `,

  /** Mark an approval as approved. Parameters: [approved_by, id] */
  markApproved: `
    UPDATE approvals
    SET status = 'approved', approved_by = ?, approved_on = NOW()
    WHERE id = ?
  `,

  /** Mark an approval as rejected with mandatory remarks. Parameters: [approved_by, remarks, id] */
  markRejected: `
    UPDATE approvals
    SET status = 'rejected', approved_by = ?, approved_on = NOW(), remarks = ?
    WHERE id = ?
  `,

  // ── Read ────────────────────────────────────────────────────────────────

  /** All pending approvals with submitter name — drives the Approvals page.
   *  No parameters.
   */
  listPending: `
    SELECT
      a.id,
      a.module,
      a.entity_id,
      a.raised_on,
      u.name AS raised_by_name
    FROM approvals a
    JOIN users u ON u.id = a.raised_by
    WHERE a.status = 'pending'
    ORDER BY a.raised_on DESC
  `,

  /** Field-level diff rows for one approval. Parameters: [approval_id] */
  getItems: `
    SELECT field_name, old_value, new_value
    FROM approval_items
    WHERE approval_id = ?
  `,

  /** Single approval header used by the approve/reject handler. Parameters: [id] */
  getById: `
    SELECT id, module, entity_id, raised_by, status
    FROM approvals
    WHERE id = ?
  `,

  /** Prevent double-submit: check if an entity already has a pending approval.
   *  Parameters: [module, entity_id]
   *  Returns one row if pending, zero rows if clear.
   */
  hasPending: `
    SELECT id FROM approvals
    WHERE module = ? AND entity_id = ? AND status = 'pending'
    LIMIT 1
  `,

  /** Fetch the most recent rejection for a given entity, with submitter + rejector names.
   *  Used by edit dialogs to show why a draft was rejected and who owns re-editing it.
   *  Parameters: [module, entity_id]
   */
  selectLatestRejection: `
    SELECT
      a.raised_by,
      a.remarks,
      a.approved_on AS rejected_on,
      u_raised.name   AS raised_by_name,
      u_approved.name AS rejected_by_name
    FROM approvals a
    LEFT JOIN users u_raised   ON u_raised.id   = a.raised_by
    LEFT JOIN users u_approved ON u_approved.id  = a.approved_by
    WHERE a.module = ? AND a.entity_id = ? AND a.status = 'rejected'
    ORDER BY a.approved_on DESC
    LIMIT 1
  `,

  /**
   * Resolved approvals (approved or rejected) — the audit trail behind the
   * "Approval History" page. `approvals` rows are never deleted, so this is
   * the same table `listPending` reads, just the complementary status set.
   * Params: [module, module, status, status, LIMIT, OFFSET]
   *   module — a MODULE_LABEL key or null (no filter)
   *   status — 'approved'|'rejected' or null (no filter — both shown)
   */
  listHistory: `
    SELECT
      a.id,
      a.module,
      a.entity_id,
      a.raised_on,
      a.status,
      a.remarks,
      a.approved_on,
      u.name  AS raised_by_name,
      ua.name AS approved_by_name
    FROM approvals a
    JOIN users u ON u.id = a.raised_by
    LEFT JOIN users ua ON ua.id = a.approved_by
    WHERE a.status IN ('approved', 'rejected')
      AND (? IS NULL OR a.module = ?)
      AND (? IS NULL OR a.status = ?)
    ORDER BY a.approved_on DESC
    LIMIT ? OFFSET ?
  `,

  /** Matching COUNT for listHistory. Params: [module, module, status, status] */
  countHistory: `
    SELECT COUNT(*) AS total
    FROM approvals a
    WHERE a.status IN ('approved', 'rejected')
      AND (? IS NULL OR a.module = ?)
      AND (? IS NULL OR a.status = ?)
  `,

  /**
   * Full approval history for ONE entity — pending, approved, and rejected
   * alike — backing the shared per-row "History" dialog
   * (components/masters/EntityHistoryDialog.tsx). Unlike listHistory (which
   * feeds the module-wide /approvals/history page and deliberately excludes
   * pending rows), this shows the complete lineage for a single record.
   * Params: [module, entity_id]
   */
  listHistoryForEntity: `
    SELECT
      a.id,
      a.module,
      a.entity_id,
      a.approval_type,
      a.raised_on,
      a.status,
      a.remarks,
      a.approved_on,
      u.name  AS raised_by_name,
      ua.name AS approved_by_name
    FROM approvals a
    JOIN users u ON u.id = a.raised_by
    LEFT JOIN users ua ON ua.id = a.approved_by
    WHERE a.module = ? AND a.entity_id = ?
    ORDER BY a.raised_on DESC
  `,

  /**
   * Same shape as listHistoryForEntity, but for every Recipe version belonging
   * to one SKU at once — RM/PM now version independently, so a SKU can
   * accumulate many master_recipe rows (one per version) over time, each with
   * its own approval. The row-level "History" dialog for Recipe resolves the
   * clicked Recipe's sku_id first (see app/api/v1/approvals/entity-history/route.ts),
   * then passes ALL of that SKU's bom_ids here so the full recipe lineage
   * shows as one linked trail instead of being siloed per version.
   * Params: [bom_ids[]] — used via query() (pool.query), which expands an
   * array param into IN (?)'s comma-separated list.
   */
  listHistoryForBomIds: `
    SELECT
      a.id,
      a.module,
      a.entity_id,
      a.approval_type,
      a.raised_on,
      a.status,
      a.remarks,
      a.approved_on,
      u.name  AS raised_by_name,
      ua.name AS approved_by_name
    FROM approvals a
    JOIN users u ON u.id = a.raised_by
    LEFT JOIN users ua ON ua.id = a.approved_by
    WHERE a.module = 'BOM' AND a.entity_id IN (?)
    ORDER BY a.raised_on DESC
  `,
}
