/**
 * Generic per-module audit trail — `history_masters_edits`.
 *
 * Populated alongside (not instead of) the `approvals`/`approval_items`
 * pending-review mechanism: one row is inserted per create/edit/delete
 * submission, then approve/reject updates that SAME row's status/approved_by/
 * approved_on in place. Any module can adopt this by inserting on submit and
 * letting the shared approve/reject route resolve the pending row — see
 * lib/master-routes/history-utils.ts.
 */

export const historySql = {
  /** Parameters: [module, entity_id] */
  nextVersion: `
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next
    FROM history_masters_edits
    WHERE module = ? AND entity_id = ?
  `,

  /**
   * Insert one audit-trail row for a create/edit/delete submission.
   *
   * created_on is a UTC instant — plain NOW(), matching the DB session. It was
   * previously shifted to IST wall-clock on the way in, which mysql2 then read
   * back as UTC and the UI shifted to IST a second time. Storage is UTC;
   * display converts once, in IST, via lib/date.ts.
   *
   * Parameters: [module, entity_id, action_type, remarks, created_by, version_no]
   */
  insert: `
    INSERT INTO history_masters_edits
      (module, entity_id, action_type, remarks, created_by, created_on, version_no)
    VALUES (?, ?, ?, ?, ?, NOW(), ?)
  `,

  /**
   * Resolve the most recent pending row for this entity to approved/rejected.
   * approved_on is a UTC instant, like created_on above.
   * Parameters: [status, approved_by, module, entity_id]
   */
  resolvePending: `
    UPDATE history_masters_edits
    SET status = ?, approved_by = ?, approved_on = NOW()
    WHERE module = ? AND entity_id = ? AND status = 'pending'
    ORDER BY created_on DESC, id DESC
    LIMIT 1
  `,

  /**
   * The submitter's free-text reason for the currently pending edit on this
   * entity. Reliable 1:1 lookup because approvals.hasPending already
   * guarantees at most one pending approval per (module, entity_id), so at
   * most one pending history_masters_edits row can match too.
   * Parameters: [module, entity_id]
   */
  selectPendingRemarks: `
    SELECT remarks
    FROM history_masters_edits
    WHERE module = ? AND entity_id = ? AND status = 'pending'
    ORDER BY created_on DESC, id DESC
    LIMIT 1
  `,

  /** Full audit trail for one entity, newest first, with human-readable names.
   *  id DESC breaks ties within the same second — created_on is DATETIME(0).
   *  Parameters: [module, entity_id] */
  selectForEntity: `
    SELECT
      h.id, h.action_type, h.remarks, h.status, h.version_no,
      h.created_on, h.approved_on,
      cu.name AS created_by_name,
      au.name AS approved_by_name
    FROM history_masters_edits h
    LEFT JOIN users cu ON cu.id = h.created_by
    LEFT JOIN users au ON au.id = h.approved_by
    WHERE h.module = ? AND h.entity_id = ?
    ORDER BY h.created_on DESC, h.id DESC
  `,
}
