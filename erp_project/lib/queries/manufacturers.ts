/**
 * Manufacturers Queries
 * Centralized queries for manufacturers table (mfgs)
 */

export const manufacturers = {
  // ============ SELECT QUERIES ============

  /** Get all manufacturers with their details. */
  selectAll: `
    SELECT mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.gst_certificate_key, mfgd.cancelled_cheque_key,
      mfgd.pan_card_key, mfgd.misc_document_key,
      mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    ORDER BY mfg.code ASC
  `,

  /** Resolve a manufacturer by its business code — used by rate-bulk CSV
   *  imports. Parameters: [code] */
  selectByCode: `
    SELECT mfg.id, mfg.code, mfg.name, mfgd.status
    FROM master_mfgs mfg
    LEFT JOIN details_mfg mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfg.code = ? LIMIT 1
  `,
  // ============ PAGINATED SELECT QUERIES ============

  /**
   * Paginated manufacturer list with optional search.
   * Params: [like, like, like, LIMIT, OFFSET]
   *   like — '%search%' or null
   */
  selectPaginated: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfgd.gst_certificate_key, mfgd.cancelled_cheque_key,
      mfgd.pan_card_key, mfgd.misc_document_key, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE (? IS NULL OR mfg.code LIKE ? OR mfg.name LIKE ?)
    ORDER BY mfg.code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching manufacturers for export (no LIMIT/OFFSET).
   * Same WHERE clause as selectPaginated.
   * Params: [like, like, like]
   */
  selectAllFiltered: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE (? IS NULL OR mfg.code LIKE ? OR mfg.name LIKE ?)
    ORDER BY mfg.code ASC
  `,

  /**
   * Matching COUNT for selectPaginated.
   * Params: [like, like, like]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE (? IS NULL OR mfg.code LIKE ? OR mfg.name LIKE ?)
  `,

  // ============ INSERT QUERIES ============

  /**
   * Insert a single manufacturer record
   * Parameters: [code, name]
   */
  insert: `
    INSERT INTO master_mfgs (code, name) VALUES (?, ?)
  `,

  /** Total manufacturer count — used to seed the next auto-generated code serial. */
  countTotal: `SELECT COUNT(*) AS total FROM master_mfgs`,

  /**
   * Insert manufacturer details record.
   * Parameters: [mfg_id, location, gst_number, status, registered_name, zone, bank_name, ifsc_number, account_number, email]
   * Must be called after insert with the insertId.
   */
  insertDetails: `
    INSERT INTO details_mfg (mfg_id, location, gst_number, status, registered_name, zone, bank_name, ifsc_number, account_number, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  // ============ UPDATE QUERIES ============

  /** Update manufacturer name. Parameters: [name, id] */
  updateMfg: `
    UPDATE master_mfgs SET name = ? WHERE id = ?
  `,

  /**
   * Apply approved S3 keys for a manufacturer's reference documents.
   * Called by mfgHandler.applyAndArchive — not used for direct writes.
   * Parameters: [gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key, mfg_id]
   */
  updateDocuments: `
    UPDATE details_mfg
    SET gst_certificate_key = ?, cancelled_cheque_key = ?, pan_card_key = ?, misc_document_key = ?
    WHERE mfg_id = ?
  `,

  /** Update manufacturer details. Parameters: [location, gst_number, status, registered_name, zone, bank_name, ifsc_number, account_number, email, mfg_id] */
  updateMfgDetails: `
    UPDATE details_mfg
    SET location = ?, gst_number = ?, status = ?,
        registered_name = ?, zone = ?, bank_name = ?,
        ifsc_number = ?, account_number = ?, email = ?
    WHERE mfg_id = ?
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Fetch a single manufacturer by id (JOIN base + details).
   *  Parameters: [mfg_id]
   */
  selectById: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfgd.gst_certificate_key, mfgd.cancelled_cheque_key,
      mfgd.pan_card_key, mfgd.misc_document_key, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfg.id = ? LIMIT 1
  `,

  /** Set status on the details_mfg row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, mfg_id]
   */
  setStatus: `UPDATE details_mfg SET status = ? WHERE mfg_id = ?`,

  /** Lightweight fetch of code + name — used when building readable approval diffs. Parameters: [id] */
  selectNameById: `SELECT code, name FROM master_mfgs WHERE id = ? LIMIT 1`,

  /**
   * Exact-name lookup (case-insensitive per the table's default collation) —
   * one of three single-field lookups (name / registered_name / gst_number)
   * the bulk CSV importer's edit-match scorer (lib/master-routes/edit-match.ts)
   * unions together to decide whether a row is an edit of an existing record.
   * Parameters: [name]
   */
  selectByName: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfg.name = ? LIMIT 1
  `,

  /** Same shape as selectByName, keyed on registered_name. Parameters: [registered_name] */
  selectByRegisteredName: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfgd.registered_name = ? LIMIT 5
  `,

  /** Same shape as selectByName, keyed on gst_number. Parameters: [gst_number] */
  selectByGstNumber: `
    SELECT
      mfg.id, mfgd.mfg_id, mfgd.status, mfgd.location,
      mfgd.gst_number, mfgd.registered_name, mfgd.zone,
      mfgd.bank_name, mfgd.ifsc_number, mfgd.account_number,
      mfgd.email, mfg.code, mfg.name
    FROM master_mfgs AS mfg
    INNER JOIN details_mfg AS mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfgd.gst_number = ? LIMIT 5
  `,

  // ── Duplicate checks (banking/tax fields must be unique across manufacturers) ─
  // `excludeMfgId` is 0 on create (no self to exclude) or the current mfg_id on
  // update, so the manufacturer being edited never flags itself as a duplicate.

  /** Parameters: [gst_number, excludeMfgId] */
  checkDuplicateGst: `
    SELECT mfg.code FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.gst_number = ? AND d.mfg_id != ? LIMIT 1
  `,

  /** Parameters: [ifsc_number, excludeMfgId] */
  checkDuplicateIfsc: `
    SELECT mfg.code FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.ifsc_number = ? AND d.mfg_id != ? LIMIT 1
  `,

  /** Parameters: [account_number, excludeMfgId] */
  checkDuplicateAccountNumber: `
    SELECT mfg.code FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.account_number = ? AND d.mfg_id != ? LIMIT 1
  `,

  // ── Batched duplicate lookups for CSV-preview duplicate checking ──────────
  // Each returns { code, value } for every existing row whose value is in the
  // given IN (?) list — one query per field for the whole uploaded file,
  // instead of one query per row.

  /** Parameters: [gst_numbers[]] */
  checkDuplicateGstBatch: `
    SELECT mfg.code, d.gst_number AS value FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.gst_number IN (?)
  `,

  /** Parameters: [ifsc_numbers[]] */
  checkDuplicateIfscBatch: `
    SELECT mfg.code, d.ifsc_number AS value FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.ifsc_number IN (?)
  `,

  /** Parameters: [account_numbers[]] */
  checkDuplicateAccountNumberBatch: `
    SELECT mfg.code, d.account_number AS value FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.account_number IN (?)
  `,

  /** Parameters: [emails[]] */
  checkDuplicateEmailBatch: `
    SELECT mfg.code, d.email AS value FROM details_mfg d
    JOIN master_mfgs mfg ON mfg.id = d.mfg_id
    WHERE d.email IN (?)
  `,

  /** Parameters: [names[]] */
  checkDuplicateNameBatch: `
    SELECT mfg.id, mfg.code, mfg.name AS value FROM master_mfgs mfg
    WHERE mfg.name IN (?)
  `,

  // ── Full-row batch lookups for the CSV-preview edit-match scorer ──────────
  // Same shape as selectByName/selectByRegisteredName/selectByGstNumber but
  // IN (?)-batched across the whole uploaded file — see
  // lib/master-routes/edit-match.ts's fetchEditMatchCandidates.

  /** Parameters: [names[]] */
  selectCandidatesByNamesBatch: `
    SELECT mfg.id, mfg.code, mfg.name, mfgd.location, mfgd.gst_number,
      mfgd.registered_name, mfgd.zone, mfgd.bank_name, mfgd.ifsc_number,
      mfgd.account_number, mfgd.email
    FROM master_mfgs mfg
    JOIN details_mfg mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfg.name IN (?)
  `,

  /** Parameters: [registered_names[]] */
  selectCandidatesByRegisteredNamesBatch: `
    SELECT mfg.id, mfg.code, mfg.name, mfgd.location, mfgd.gst_number,
      mfgd.registered_name, mfgd.zone, mfgd.bank_name, mfgd.ifsc_number,
      mfgd.account_number, mfgd.email
    FROM master_mfgs mfg
    JOIN details_mfg mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfgd.registered_name IN (?)
  `,

  /** Parameters: [gst_numbers[]] */
  selectCandidatesByGstNumbersBatch: `
    SELECT mfg.id, mfg.code, mfg.name, mfgd.location, mfgd.gst_number,
      mfgd.registered_name, mfgd.zone, mfgd.bank_name, mfgd.ifsc_number,
      mfgd.account_number, mfgd.email
    FROM master_mfgs mfg
    JOIN details_mfg mfgd ON mfgd.mfg_id = mfg.id
    WHERE mfgd.gst_number IN (?)
  `,

  /**
   * Build the filter parameter array for selectPaginated, selectAllFiltered, and countAll.
   * Centralises the repeated-param pattern so callers never have to count repetitions.
   *
   * Usage:
   *   const fp = manufacturers.filterParams(search)
   *   paginate(manufacturers.selectPaginated, [...fp, limit, offset], manufacturers.countAll, fp, ...)
   */
  filterParams(search: string | null): unknown[] {
    const like = search ? `%${search}%` : null
    return [like, like, like]
  },
}
