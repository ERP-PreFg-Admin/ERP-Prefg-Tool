/**
 * Purchase Orders Queries
 *
 * Real table: purchase_orders
 * Columns: id, po_no, mfg_id, date, sku_code, bom_id, qty, unit_price,
 *          total_amount, expected_on, received_qty, invoice_no, status,
 *          po_type, email_sent_at, attachment_key, csv_source_key, destination
 */

// Overrides the stored status with a computed "partially_received" whenever
// some (but not all) of the ordered qty has come in — terminal/manual states
// (cancelled, short_closed, received) always win over the quantity math.
const EFFECTIVE_STATUS_EXPR = `
  CASE
    WHEN po.status IN ('cancelled', 'short_closed', 'received') THEN po.status
    WHEN po.received_qty > 0 AND po.received_qty < po.qty THEN 'partially_received'
    ELSE po.status
  END
`

// ── Shared WHERE fragment (all filters) ──────────────────────────────────────
// Params (21): [like×6, status×3, mfgCode×2, poType×2, dateFrom×2, dateTo×2, sku×2, destination×2]
// The status filter matches an IN-list rather than a single value so the
// "received" tab can also pull in short-closed POs — see statusMatchValues().
const FULL_WHERE = `
  WHERE (? IS NULL OR po.po_no LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR po.sku_code LIKE ? OR sk.name LIKE ?)
    AND (? IS NULL OR ${EFFECTIVE_STATUS_EXPR} IN (?, ?))
    AND (? IS NULL OR m.code         = ?)
    AND (? IS NULL OR po.po_type     = ?)
    AND (? IS NULL OR po.date       >= ?)
    AND (? IS NULL OR po.date       <= ?)
    AND (? IS NULL OR po.sku_code    = ?)
    AND (? IS NULL OR po.destination = ?)
`

// Params (18): [like×6, mfgCode×2, poType×2, dateFrom×2, dateTo×2, sku×2, destination×2]
// Used by statusCounts and summaryStats which ignore the status filter.
const SUMMARY_WHERE = `
  WHERE (? IS NULL OR po.po_no LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR po.sku_code LIKE ? OR sk.name LIKE ?)
    AND (? IS NULL OR m.code         = ?)
    AND (? IS NULL OR po.po_type     = ?)
    AND (? IS NULL OR po.date       >= ?)
    AND (? IS NULL OR po.date       <= ?)
    AND (? IS NULL OR po.sku_code    = ?)
    AND (? IS NULL OR po.destination = ?)
`

const FROM_JOINS = `
  FROM purchase_orders po
  INNER JOIN master_mfgs m  ON m.id        = po.mfg_id
  LEFT  JOIN master_skus sk ON sk.sku_code = po.sku_code
`

const SELECT_COLS = `
  SELECT
    po.id, po.po_no, po.date, po.sku_code, po.qty, po.unit_price,
    po.total_amount, po.expected_on, po.received_qty, po.invoice_no,
    po.destination, ${EFFECTIVE_STATUS_EXPR} AS status, po.po_type, po.attachment_key,
    po.csv_source_key, po.email_sent_at,
    m.id   AS mfg_id, m.code AS mfg_code, m.name AS mfg_name,
    sk.name   AS sku_name, sk.status AS sku_status,
    (SELECT raised_by FROM approvals WHERE module = 'PO' AND entity_id = po.id ORDER BY id DESC LIMIT 1) AS po_raised_by,
    (SELECT email FROM details_mfg WHERE mfg_id = m.id LIMIT 1) AS mfg_email
`

const SAFE_SORT_COLS: Record<string, string> = {
  date:         "po.date",
  po_no:        "po.po_no",
  mfg_name:     "m.name",
  sku_code:     "po.sku_code",
  qty:          "po.qty",
  unit_price:   "po.unit_price",
  total_amount: "po.total_amount",
  expected_on:  "po.expected_on",
  status:       `(${EFFECTIVE_STATUS_EXPR})`,
}

export const purchaseOrdersSql = {
  /** All POs joined with manufacturer name, SKU name, and who originally raised each PO. */
  selectAll: `
    ${SELECT_COLS}
    ${FROM_JOINS}
    ORDER BY po.date DESC, po.id DESC
  `,

  /**
   * Paginated PO list with all filters.
   * Use buildSelectPaginated(sortBy, sortDir) to get the sorted variant.
   * Params: buildFilterParams(...) + [LIMIT, OFFSET]  (21 + 2 = 23 total)
   */
  buildSelectPaginated(sortBy = "date", sortDir: "asc" | "desc" = "desc"): string {
    const col = SAFE_SORT_COLS[sortBy] ?? "po.date"
    const dir = sortDir === "asc" ? "ASC" : "DESC"
    return `
      ${SELECT_COLS}
      ${FROM_JOINS}
      ${FULL_WHERE}
      ORDER BY ${col} ${dir}, po.id ${dir}
      LIMIT ? OFFSET ?
    `
  },

  /** COUNT matching the full WHERE. Params: buildFilterParams(...)  (21 total) */
  countPaginated: `
    SELECT COUNT(*) AS total
    ${FROM_JOINS}
    ${FULL_WHERE}
  `,

  /** Per-status counts for tab badges (ignores status param). Params: buildStatusCountParams(...)  (18 total) */
  statusCounts: `
    SELECT ${EFFECTIVE_STATUS_EXPR} AS status, COUNT(*) AS cnt
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
    GROUP BY ${EFFECTIVE_STATUS_EXPR}
  `,

  /** Summary stats for the cards (ignores status param). Params: buildStatusCountParams(...)  (14 total) */
  summaryStats: `
    SELECT
      COUNT(*) AS total,
      SUM(${EFFECTIVE_STATUS_EXPR} = 'raised')             AS raised,
      SUM(${EFFECTIVE_STATUS_EXPR} = 'punched')            AS punched,
      SUM(${EFFECTIVE_STATUS_EXPR} = 'partially_received') AS partially_received,
      SUM(CASE WHEN po.status NOT IN ('received','cancelled')
               THEN COALESCE(po.total_amount, 0) ELSE 0 END) AS open_value
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
  `,

  /** Count of POs with a given po_no prefix — used for brand-scoped PO number generation. Parameters: ['MCA-PO-202606-%'] */
  countByPrefix: `
    SELECT COUNT(*) AS cnt FROM purchase_orders WHERE po_no LIKE ?
  `,

  /**
   * Insert an impromptu PO as draft (pending approval).
   * Parameters: [po_no, mfg_id, sku_code, qty, unit_price, total_amount, expected_on, po_type, destination]
   */
  insert: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, 'draft', ?, ?)
  `,

  /**
   * Insert a normal PO directly as raised (no approval needed).
   * Parameters: [po_no, mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination]
   */
  insertNormal: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, 'raised', 'normal', ?)
  `,

  /** Set status on a purchase_orders row. Parameters: [status, id] */
  setStatus: `UPDATE purchase_orders SET status = ? WHERE id = ?`,

  /** Credit split qty back to the parent as received_qty (never mutates qty). Parameters: [splitTotal, id] */
  incrementReceivedQtyBySplit: `UPDATE purchase_orders SET received_qty = COALESCE(received_qty, 0) + ? WHERE id = ?`,

  /** Fetch MFG name for readable approval diff. Parameters: [id] */
  selectById: `
    SELECT po.id, po.po_no, po.sku_code, po.qty, po.expected_on,
           m.code AS mfg_code, m.name AS mfg_name
    FROM purchase_orders po
    JOIN master_mfgs m ON m.id = po.mfg_id
    WHERE po.id = ? LIMIT 1
  `,

  /** Lightweight SKU list for the Impromptu PO dropdown. */
  skuOptions: `
    SELECT id, sku_code, name, status
    FROM master_skus
    WHERE status NOT IN ('inactive', 'discontinued')
    ORDER BY sku_code ASC
  `,

  /** All warehouses for the destination dropdown. */
  warehouseOptions: `
    SELECT id, name, location, zone, type
    FROM master_warehouse
    ORDER BY type DESC, name ASC
  `,

  /** Lightweight MFG list for the Impromptu PO dropdown. */
  mfgOptions: `
    SELECT m.id, m.code, m.name
    FROM master_mfgs m
    INNER JOIN details_mfg d ON d.mfg_id = m.id
    WHERE d.status = 'active'
    ORDER BY m.code ASC
  `,

  /** Lightweight PO fetch used for status checks and po_no retrieval. Parameters: [id] */
  selectForEdit: `
    SELECT id, po_no, status FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /** Fetch the user who originally submitted this PO. Parameters: [po_id] */
  selectRaisedBy: `
    SELECT raised_by FROM approvals
    WHERE module = 'PO' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `,

  /** Full PO row for split operations. Parameters: [id] */
  selectForSplit: `
    SELECT id, po_no, mfg_id, sku_code, qty, received_qty, expected_on, status
    FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /** Insert a split child PO with an explicit status. Parameters: [po_no, mfg_id, sku_code, qty, expected_on, status, destination] */
  insertSplit: `
    INSERT INTO purchase_orders (po_no, mfg_id, date, sku_code, qty, expected_on, status, destination)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?)
  `,

  /**
   * Insert a PO directly as 'raised' for the bulk CSV flow.
   * Parameters: [po_no, mfg_id, sku_code, qty, expected_on, destination, csv_source_key]
   */
  insertBulkPo: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, expected_on, status, po_type, destination, csv_source_key)
    VALUES (?, ?, CURDATE(), ?, ?, ?, 'raised', 'normal', ?, ?)
  `,

  /**
   * Update editable fields on a draft PO.
   * Parameters: [mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, id]
   */
  updateDraft: `
    UPDATE purchase_orders
    SET mfg_id = ?, sku_code = ?, qty = ?, unit_price = ?, total_amount = ?,
        expected_on = ?, destination = ?
    WHERE id = ?
  `,

  /**
   * Itemized ongoing (not received, not cancelled) POs for one manufacturer.
   * Drives the mfg-batch screen's "current open POs" panel and the batch
   * email's "currently open" summary section. Parameters: [mfg_id]
   */
  ongoingByMfg: `
    SELECT po.id, po.po_no, po.sku_code, sk.name AS sku_name, po.qty,
           po.expected_on, ${EFFECTIVE_STATUS_EXPR} AS status
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    WHERE po.mfg_id = ?
      AND ${EFFECTIVE_STATUS_EXPR} NOT IN ('received', 'cancelled')
    ORDER BY po.date DESC, po.id DESC
  `,

  /**
   * Fetch PO + SKU + manufacturer info for an arbitrary set of PO ids —
   * drives the "select POs, review, send mail" flow's grouping-by-manufacturer
   * step. Use buildSelectByIds(count) for the placeholder-count-matched SQL.
   * Params: [...ids]
   */
  buildSelectByIds(count: number): string {
    const placeholders = Array(count).fill("?").join(",")
    return `
      SELECT po.id, po.po_no, po.mfg_id, m.code AS mfg_code, m.name AS mfg_name,
             po.sku_code, sk.name AS sku_name, po.qty, ${EFFECTIVE_STATUS_EXPR} AS status
      FROM purchase_orders po
      INNER JOIN master_mfgs m ON m.id = po.mfg_id
      LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
      WHERE po.id IN (${placeholders})
    `
  },

  /** Full PO data for email generation and PDF rendering. Parameters: [po_id] */
  selectForEmail: `
    SELECT
      po.po_no, po.date, po.expected_on, po.destination,
      po.sku_code, po.qty, po.unit_price, po.total_amount,
      sk.name            AS sku_name,
      m.code             AS mfg_code,
      m.name             AS mfg_name,
      d.registered_name, d.gst_number, d.location, d.email AS mfg_email,
      wh.location        AS dest_location,
      u.name             AS raised_by_name
    FROM purchase_orders po
    INNER JOIN master_mfgs      m  ON m.id          = po.mfg_id
    INNER JOIN details_mfg      d  ON d.mfg_id      = m.id
    LEFT  JOIN master_skus      sk ON sk.sku_code    = po.sku_code
    LEFT  JOIN master_warehouse wh ON wh.name        = po.destination
    LEFT  JOIN (
      SELECT entity_id, raised_by FROM approvals
      WHERE module = 'PO'
      ORDER BY id DESC
    ) latest ON latest.entity_id = po.id
    LEFT  JOIN users u ON u.id = latest.raised_by
    WHERE po.id = ?
    LIMIT 1
  `,
}

// ── Filter parameter helpers ──────────────────────────────────────────────────

/**
 * The "received" tab also pulls in short-closed POs, since short-closing is
 * just an early/manual way of finishing a PO. Every other status filters
 * on its own exact value (the IN-list just repeats it twice).
 */
function statusMatchValues(status: string | null): [unknown, unknown] {
  if (status === "received") return ["received", "short_closed"]
  return [status, status]
}

/**
 * Build the 21-element param array for selectPaginated / countPaginated.
 * All-null values disable the corresponding filter.
 */
export function buildFilterParams(
  search:      string | null,
  status:      string | null,
  mfgCode:     string | null,
  poType:      string | null,
  dateFrom:    string | null,
  dateTo:      string | null,
  sku:         string | null,
  destination: string | null,
): unknown[] {
  const like = search ? `%${search}%` : null
  const [statusA, statusB] = statusMatchValues(status)
  return [
    like, like, like, like, like, like,     // search ×6
    status,      statusA,      statusB,     // status ×3 (IS NULL check + IN-list pair)
    mfgCode,     mfgCode,               // mfgCode ×2
    poType,      poType,                // poType ×2
    dateFrom,    dateFrom,              // dateFrom ×2
    dateTo,      dateTo,                // dateTo ×2
    sku,         sku,                   // sku ×2
    destination, destination,           // destination ×2
  ]
}

/**
 * Build the 18-element param array for statusCounts / summaryStats
 * (same as buildFilterParams but without the status filter pair).
 */
export function buildStatusCountParams(
  search:      string | null,
  mfgCode:     string | null,
  poType:      string | null,
  dateFrom:    string | null,
  dateTo:      string | null,
  sku:         string | null,
  destination: string | null,
): unknown[] {
  const like = search ? `%${search}%` : null
  return [
    like, like, like, like, like, like, // search ×6
    mfgCode,     mfgCode,               // mfgCode ×2
    poType,      poType,                // poType ×2
    dateFrom,    dateFrom,              // dateFrom ×2
    dateTo,      dateTo,                // dateTo ×2
    sku,         sku,                   // sku ×2
    destination, destination,           // destination ×2
  ]
}
