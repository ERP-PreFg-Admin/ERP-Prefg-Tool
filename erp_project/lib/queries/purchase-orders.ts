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
// Params (22): [like×6, status×4, mfgCode×2, poType×2, dateFrom×2, dateTo×2, sku×2, destination×2]
// The status filter matches an IN-list rather than a single value so the
// "received" tab can also pull in short-closed POs and the PO Inwarding page's
// "open" tab can span raised/punched/partially_received — see statusMatchValues().
const FULL_WHERE = `
  WHERE (? IS NULL OR po.po_no LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR po.sku_code LIKE ? OR sk.name LIKE ?)
    AND (? IS NULL OR ${EFFECTIVE_STATUS_EXPR} IN (?, ?, ?))
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
   * Params: buildFilterParams(...) + [LIMIT, OFFSET]  (22 + 2 = 24 total)
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

  /** COUNT matching the full WHERE. Params: buildFilterParams(...)  (22 total) */
  countPaginated: `
    SELECT COUNT(*) AS total
    ${FROM_JOINS}
    ${FULL_WHERE}
  `,

  /**
   * Every PO matching the full WHERE, unpaginated — for the CSV/Excel export
   * (which must return all rows a filtered/searched view would page through,
   * not just the current page). Params: buildFilterParams(...)  (22 total)
   */
  buildSelectFiltered(sortBy = "date", sortDir: "asc" | "desc" = "desc"): string {
    const col = SAFE_SORT_COLS[sortBy] ?? "po.date"
    const dir = sortDir === "asc" ? "ASC" : "DESC"
    return `
      ${SELECT_COLS}
      ${FROM_JOINS}
      ${FULL_WHERE}
      ORDER BY ${col} ${dir}, po.id ${dir}
    `
  },

  /** Per-status counts for tab badges (ignores status param). Params: buildStatusCountParams(...)  (18 total) */
  statusCounts: `
    SELECT ${EFFECTIVE_STATUS_EXPR} AS status, COUNT(*) AS cnt
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
    GROUP BY ${EFFECTIVE_STATUS_EXPR}
  `,

  /**
   * Count for the Inward tab. Separate from statusCounts because that groups by
   * status, and "inward" cuts across every status — it's a po_type. Takes the
   * same 18 filter params so the badge tracks the other filters.
   */
  inwardCount: `
    SELECT COUNT(*) AS cnt
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
      AND po.po_type = 'inward'
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

  /**
   * Insert an inward PO — one per line item of a parsed supplier invoice.
   * Raised immediately (the invoice is the authorisation), and carries the
   * invoice number plus the S3 key of the original PDF so the inwarding desk
   * can pull the source document back up from the row. received_qty is left at
   * its 0 default: creating the PO is not receiving against it.
   * Parameters: [po_no, mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, invoice_no, attachment_key]
   */
  insertInward: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination, invoice_no, attachment_key)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, 'raised', 'inward', ?, ?, ?)
  `,

  /**
   * Inward PO for an invoice line that was also received against an existing
   * PO. Booked straight in as fully received — the goods are physically here,
   * which is the whole point of the invoice — and reference_po points back at
   * the order it fulfils so the two rows aren't mistaken for separate demand.
   * Parameters: [po_no, mfg_id, sku_code, qty, unit_price, total_amount,
   *   expected_on, destination, invoice_no, attachment_key, received_qty, reference_po]
   */
  insertInwardReceived: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination, invoice_no, attachment_key, received_qty, reference_po)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, 'received', 'inward', ?, ?, ?, ?, ?)
  `,

  /** Set status on a purchase_orders row. Parameters: [status, id] */
  setStatus: `UPDATE purchase_orders SET status = ? WHERE id = ?`,

  /** Credit a manual goods-receipt qty to received_qty. Parameters: [qty, id] */
  incrementReceivedQtyManual: `UPDATE purchase_orders SET received_qty = COALESCE(received_qty, 0) + ? WHERE id = ?`,

  /**
   * Set the parent's qty and total_amount after a split (caller computes both
   * from the pre-split values so this statement doesn't need to re-derive
   * anything from the row it's updating). status and received_qty are
   * untouched — split is not a receiving event. Parameters: [newQty, newTotalAmount, id]
   */
  setQtyAndTotalAfterSplit: `
    UPDATE purchase_orders
    SET qty = ?, total_amount = ?
    WHERE id = ?
  `,

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
    SELECT id, po_no, mfg_id, sku_code, qty, unit_price, received_qty, expected_on, status
    FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /** Full PO row for a manual receive operation. Parameters: [id] */
  /** Same as selectForReceive but locks the row for the duration of the transaction — prevents two concurrent receives from both reading a stale received_qty. Parameters: [id] */
  selectForReceiveLocked: `
    SELECT id, po_no, sku_code, qty, received_qty, status
    FROM purchase_orders WHERE id = ? LIMIT 1 FOR UPDATE
  `,

  /** Insert a split child PO with an explicit status. Parameters: [po_no, mfg_id, sku_code, qty, expected_on, status, destination, reference_po] */
  insertSplit: `
    INSERT INTO purchase_orders (po_no, mfg_id, date, sku_code, qty, expected_on, status, destination, reference_po, po_type)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'normal')
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

  // ── PO Bulk Upload — create-or-update by po_no, + history_pos audit trail ──

  /** Look up an existing PO by its unique po_no — used by the bulk CSV importer to decide create vs. update. Params: [po_no] */
  selectByPoNo: `
    SELECT id, po_no, status, expected_on, destination
    FROM purchase_orders
    WHERE po_no = ?
    LIMIT 1
  `,

  /**
   * Update only the 3 fields the bulk CSV importer is allowed to edit on an
   * existing PO (status, expected_on, destination) — qty/rate/etc. are
   * deliberately out of reach here; use updateDraft for a full field edit.
   * Parameters: [status, expected_on, destination, id]
   */
  updatePoStatusFields: `
    UPDATE purchase_orders
    SET status = ?, expected_on = ?, destination = ?
    WHERE id = ?
  `,

  /**
   * Record one history_pos row. For a "create" action, field_name/old_value/
   * new_value are all null (one summary row per new PO); for an "update"
   * action, one row per changed field. Params: [po_id, po_no, action_type, field_name, old_value, new_value, s3_key, changed_by]
   */
  insertPoHistory: `
    INSERT INTO history_pos (po_id, po_no, action_type, field_name, old_value, new_value, s3_key, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /** All history_pos entries for one PO, newest first — shown in PoTable's Actions menu. Params: [po_id] */
  selectPoHistoryByPoId: `
    SELECT h.id, h.action_type, h.field_name, h.old_value, h.new_value, h.changed_on,
           u.name AS changed_by_name
    FROM history_pos h
    LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.po_id = ?
    ORDER BY h.changed_on DESC, h.id DESC
  `,

  /**
   * Itemized ongoing (not received, not cancelled) POs for one manufacturer.
   * Drives the mfg-batch screen's "current open POs" panel and the batch
   * email's "currently open" summary section. Parameters: [mfg_id]
   */
  /**
   * Open POs a goods receipt can be booked against, for one manufacturer —
   * feeds the Add Invoice dialog's "Reference PO" picker. Only raised and
   * partially_received qualify: the same set the receive route accepts, minus
   * punched (which has no physical goods behind it yet). `remaining` is
   * returned so the picker can show how much is still outstanding and the
   * caller doesn't have to re-derive it. Parameters: [mfg_id]
   */
  openForReceiveByMfg: `
    SELECT po.id, po.po_no, po.sku_code, sk.name AS sku_name,
           po.qty, COALESCE(po.received_qty, 0) AS received_qty,
           (po.qty - COALESCE(po.received_qty, 0)) AS remaining,
           po.expected_on, ${EFFECTIVE_STATUS_EXPR} AS status
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    WHERE po.mfg_id = ?
      AND ${EFFECTIVE_STATUS_EXPR} IN ('raised', 'partially_received')
    ORDER BY po.date DESC, po.id DESC
  `,

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
 * Expand a tab's status into the 3-slot IN-list FULL_WHERE matches on.
 *
 * - "open" is a pseudo-status used by the PO Inwarding tab bar (never stored in
 *   the DB) covering every PO still awaiting goods.
 * - "received" also pulls in short-closed POs, since short-closing is just an
 *   early/manual way of finishing a PO.
 * - Everything else filters on its own exact value; repeating it to fill the
 *   remaining slots is harmless inside an IN list.
 */
export function statusMatchValues(status: string | null): [unknown, unknown, unknown] {
  if (status === "open")     return ["raised", "punched", "partially_received"]
  if (status === "received") return ["received", "short_closed", "short_closed"]
  return [status, status, status]
}

/**
 * Build the 22-element param array for selectPaginated / countPaginated.
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
  const [statusA, statusB, statusC] = statusMatchValues(status)
  return [
    like, like, like, like, like, like,               // search ×6
    status, statusA, statusB, statusC,                // status ×4 (IS NULL check + IN-list triple)
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
