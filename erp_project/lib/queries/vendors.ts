/**
 * Vendors Queries
 * Centralized queries for vendors table and vendor_details table
 *
 * Note: Vendors span two tables linked only by ID (no DB foreign key):
 *   vendors(id, code, name, type)
 *   details_vendor(vendor_id → vendors.id, location, status, zone, registered_name,
 *     gst_number, bank_name, ifsc_number, account_number)
 */

/** Full-row column list shared by selectByCodeForMatch and its IN (?)-batched
 *  counterpart below — both need every field the edit-match diff compares.
 *  `v.id AS id` is included alongside `vendor_id` so the module-agnostic
 *  edit-match resolver can key off a plain `id` field like every other
 *  master — both hold the same value. */
const VENDOR_CANDIDATE_COLUMNS = `
  v.id AS id, vd.vendor_id, v.code, v.name, v.type, vd.location, vd.zone,
  vd.registered_name, vd.gst_number, vd.bank_name, vd.ifsc_number, vd.account_number
`

export const vendors = {
  // ============ SELECT QUERIES ============

  /**
   * Get all vendors with their details
   * Used in VendorsPage
   */
  selectAll: `
    SELECT
      vd.vendor_id, vd.location, vd.status,
      vd.zone, vd.registered_name, v.code, v.name, v.type,
      vd.gst_number, vd.bank_name, vd.ifsc_number, vd.account_number
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
  `,

  /** Resolve a vendor by its business code — used by rate-bulk CSV imports.
   *  Parameters: [code] */
  selectByCode: `
    SELECT v.id, v.code, v.name, v.type, vd.status
    FROM master_vendors v
    LEFT JOIN details_vendor vd ON vd.vendor_id = v.id
    WHERE v.code = ? LIMIT 1
  `,

  // ============ PAGINATED SELECT QUERIES ============

  /**
   * Paginated vendor list with optional search + type filter.
   *
   * SQL pattern: (? IS NULL OR col LIKE ?) — passing null for the first
   * param short-circuits the condition, returning all rows.
   *
   * Params: [like, like, like, type, type, LIMIT, OFFSET]
   *   like — '%search%' or null (used three times: null-check + code LIKE + name LIKE)
   *   type — 'rm'|'pm'|'both' or null
   */
  /**
   * Paginated vendor list with optional search + type + zone filter.
   * Params: [like, like, like, type, type, zone, zone, LIMIT, OFFSET]
   */
  selectPaginated: `
    SELECT
      vd.vendor_id, vd.location, vd.status,
      vd.zone, vd.registered_name, v.code, v.name, v.type,
      vd.gst_number, vd.bank_name, vd.ifsc_number, vd.account_number,
      vd.gst_certificate_key, vd.cancelled_cheque_key, vd.pan_card_key, vd.misc_document_key
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE (? IS NULL OR v.code LIKE ? OR v.name LIKE ?)
      AND (? IS NULL OR v.type = ?)
      AND (? IS NULL OR vd.zone = ?)
    ORDER BY v.code ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Fetch ALL matching vendors for export (no LIMIT/OFFSET).
   * Params: [like, like, like, type, type, zone, zone]
   */
  selectAllFiltered: `
    SELECT
      vd.vendor_id, vd.location, vd.status,
      vd.zone, vd.registered_name, v.code, v.name, v.type,
      vd.gst_number, vd.bank_name, vd.ifsc_number, vd.account_number
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE (? IS NULL OR v.code LIKE ? OR v.name LIKE ?)
      AND (? IS NULL OR v.type = ?)
      AND (? IS NULL OR vd.zone = ?)
    ORDER BY v.code ASC
  `,

  /**
   * Matching COUNT for selectPaginated (same WHERE, no LIMIT/OFFSET).
   * Params: [like, like, like, type, type, zone, zone]
   */
  countAll: `
    SELECT COUNT(*) AS total
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE (? IS NULL OR v.code LIKE ? OR v.name LIKE ?)
      AND (? IS NULL OR v.type = ?)
      AND (? IS NULL OR vd.zone = ?)
  `,

  /** Unconditional count, used only to seed the next VEN-<serial> code. */
  countTotal: `SELECT COUNT(*) AS total FROM master_vendors`,

  /** Distinct non-null zones for the filter dropdown. */
  selectDistinctZones: `
    SELECT DISTINCT zone FROM details_vendor
    WHERE zone IS NOT NULL AND zone != ''
    ORDER BY zone ASC
  `,

  // ============ INSERT QUERIES ============

  /**
   * Insert vendor base record
   * Parameters: [code, name, type]
   * Returns insertId that should be used for details_vendor
   */
  insertVendor: `
    INSERT INTO master_vendors (code, name, type) VALUES (?, ?, ?)
  `,

  /**
   * Insert vendor details record
   * Parameters: [vendor_id, location, status, zone, registered_name, gst_number, bank_name, ifsc_number, account_number]
   * Must be called after insertVendor with the insertId
   */
  insertVendorDetails: `
    INSERT INTO details_vendor
      (vendor_id, location, status, zone, registered_name, gst_number, bank_name, ifsc_number, account_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  // ============ UPDATE QUERIES ============

  /** Update vendor name and type. Parameters: [name, type, id] */
  updateVendor: `
    UPDATE master_vendors SET name = ?, type = ? WHERE id = ?
  `,

  /** Update vendor details record.
   *  Parameters: [location, status, zone, registered_name, gst_number, bank_name, ifsc_number, account_number, vendor_id]
   */
  updateVendorDetails: `
    UPDATE details_vendor
    SET location = ?, status = ?, zone = ?, registered_name = ?,
        gst_number = ?, bank_name = ?, ifsc_number = ?, account_number = ?
    WHERE vendor_id = ?
  `,

  // ── Approval-flow helpers ────────────────────────────────────────────────

  /** Fetch a single vendor by vendor_id (JOIN base + details).
   *  Parameters: [vendor_id]
   */
  selectById: `
    SELECT
      vd.vendor_id, vd.location, vd.status,
      vd.zone, vd.registered_name, v.code, v.name, v.type,
      vd.gst_number, vd.bank_name, vd.ifsc_number, vd.account_number,
      vd.gst_certificate_key, vd.cancelled_cheque_key, vd.pan_card_key, vd.misc_document_key
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE vd.vendor_id = ? LIMIT 1
  `,

  /** Apply approved S3 keys for a vendor's reference documents.
   *  Called by vendorHandler.applyAndArchive — not used for direct writes.
   *  Parameters: [gst_certificate_key, cancelled_cheque_key, pan_card_key, misc_document_key, vendor_id]
   */
  updateDocuments: `
    UPDATE details_vendor
    SET gst_certificate_key = ?, cancelled_cheque_key = ?, pan_card_key = ?, misc_document_key = ?
    WHERE vendor_id = ?
  `,

  /** Set status on the details_vendor row (e.g. 'in_review', 'draft', 'active').
   *  Parameters: [status, vendor_id]
   */
  setStatus: `UPDATE details_vendor SET status = ? WHERE vendor_id = ?`,

  /**
   * Full-row lookup by business code — the bulk CSV importer's edit-match
   * resolver (lib/master-routes/edit-match.ts) uses this to decide a CSV
   * row is an edit of an existing record: only an exact `code` match
   * counts. Parameters: [code]
   */
  selectByCodeForMatch: `
    SELECT ${VENDOR_CANDIDATE_COLUMNS}
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE v.code = ? LIMIT 1
  `,

  /** IN (?)-batched counterpart of selectByCodeForMatch, for the whole
   *  uploaded file at once — see fetchEditMatchCandidates. Parameters: [codes[]] */
  selectCandidatesByCodesBatch: `
    SELECT ${VENDOR_CANDIDATE_COLUMNS}
    FROM details_vendor vd
    JOIN master_vendors v ON vd.vendor_id = v.id
    WHERE v.code IN (?)
  `,

  // ── Batched duplicate lookups for CSV-preview duplicate checking ──────────
  // Mirrors manufacturers.ts's equivalent batch — one query per field for the
  // whole uploaded file, instead of one query per row.

  /** Parameters: [gst_numbers[]] */
  checkDuplicateGstBatch: `
    SELECT v.code, d.gst_number AS value FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.gst_number IN (?)
  `,

  /** Parameters: [ifsc_numbers[]] */
  checkDuplicateIfscBatch: `
    SELECT v.code, d.ifsc_number AS value FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.ifsc_number IN (?)
  `,

  /** Parameters: [account_numbers[]] */
  checkDuplicateAccountNumberBatch: `
    SELECT v.code, d.account_number AS value FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.account_number IN (?)
  `,

  // ── Duplicate checks (banking/tax fields must be unique across vendors) ──────
  // `excludeVendorId` is 0 on create (no self to exclude) or the current
  // vendor_id on update, so the vendor being edited never flags itself.

  /** Parameters: [gst_number, excludeVendorId] */
  checkDuplicateGst: `
    SELECT v.code FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.gst_number = ? AND d.vendor_id != ? LIMIT 1
  `,

  /** Parameters: [ifsc_number, excludeVendorId] */
  checkDuplicateIfsc: `
    SELECT v.code FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.ifsc_number = ? AND d.vendor_id != ? LIMIT 1
  `,

  /** Parameters: [account_number, excludeVendorId] */
  checkDuplicateAccountNumber: `
    SELECT v.code FROM details_vendor d
    JOIN master_vendors v ON v.id = d.vendor_id
    WHERE d.account_number = ? AND d.vendor_id != ? LIMIT 1
  `,

  /**
   * Build the filter parameter array for selectPaginated, selectAllFiltered, and countAll.
   * Centralises the repeated-param pattern so callers never have to count repetitions.
   *
   * Usage:
   *   const fp = vendors.filterParams(search, type, zone)
   *   paginate(vendors.selectPaginated, [...fp, limit, offset], vendors.countAll, fp, ...)
   */
  filterParams(search: string | null, type: string | null, zone: string | null): unknown[] {
    const like = search ? `%${search}%` : null
    return [like, like, like, type, type, zone, zone]
  },

}
