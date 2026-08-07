/**
 * Purchase Orders Queries
 *
 * Real table: purchase_orders
 * Columns: id, po_no, mfg_id, date, sku_code, bom_id, qty, unit_price,
 *          total_amount, expected_on, received_qty, invoice_no,
 *          uniware_po_code, status, po_type, email_sent_at, attachment_key,
 *          csv_source_key, destination, reference_po
 */

import { scopeParams, type UserScope } from "@/lib/scope"

// ── Splits ───────────────────────────────────────────────────────────────────
// Splitting a PO hands part of it to a separate order rather than editing the
// original: a PO is a legal document, so po.qty never changes once raised. The
// child carries reference_po = the parent's po_no, and the "knocked off" amount
// is derived from the children, never stored on the parent.
//
// The master is the unit of record. It is the only thing PO Tracking lists, the
// only thing the totals count, and it reports its children's receipts as its
// own — so the numbers stay complete without counting the same units twice.
//
// po_type 'inward' is carved out: lib/invoice-inward.ts writes reference_po on
// the inward PO it books against an existing order, which is a receipt record,
// not a split. Those rows are deliberately untouched by all of this.
const IS_SPLIT_CHILD = `(po.reference_po IS NOT NULL AND COALESCE(po.po_type, '') <> 'inward')`

// One row per parent po_no, aggregating its live children. Cancelled children
// are excluded throughout, which is what makes cancelling a split return its
// quantity to the master's unallocated pool with no extra bookkeeping.
const CHILD_AGG_JOIN = `
  LEFT JOIN (
    SELECT c.reference_po,
           COUNT(*)                         AS child_count,
           SUM(c.qty)                       AS split_qty,
           SUM(COALESCE(c.received_qty, 0)) AS child_received_qty
    FROM purchase_orders c
    WHERE c.reference_po IS NOT NULL
      AND COALESCE(c.po_type, '') <> 'inward'
      AND COALESCE(c.status, '')  <> 'cancelled'
    GROUP BY c.reference_po
  ) ch ON ch.reference_po = po.po_no
`

// How much of the master has been handed to children. LEAST-clamped against the
// parent's own qty for the POs split before qty became immutable: their stored
// qty was already reduced by the split, so the raw sum can exceed it.
const ALLOCATED_QTY_EXPR = `LEAST(COALESCE(ch.split_qty, 0), po.qty)`

// What the master has actually received — its own receipts plus its children's.
const RECEIVED_TOTAL_EXPR = `(COALESCE(po.received_qty, 0) + COALESCE(ch.child_received_qty, 0))`

// Allocated but not yet inwarded: the amber part of the progress bar. Netting
// off child receipts is what makes amber turn green as the splits arrive —
// without it a 400 split with 150 received would read 150 + 400.
const PENDING_SPLIT_EXPR = `GREATEST(${ALLOCATED_QTY_EXPR} - COALESCE(ch.child_received_qty, 0), 0)`

// Still to order against, on the master itself: not handed to a child, not
// already received. GREATEST-clamped for the same pre-immutability rows.
const UNALLOCATED_QTY_EXPR = `GREATEST(po.qty - ${ALLOCATED_QTY_EXPR} - COALESCE(po.received_qty, 0), 0)`

// Overrides the stored status with a computed "partially_received" whenever
// some (but not all) of the ordered qty has come in — terminal/manual states
// (cancelled, short_closed, received) always win over the quantity math.
// Receipts booked on a child count here, so a master that has only ever been
// received against through its splits still reads as partially received.
//
// This is the *operational* status: what the PO is doing physically. Goods
// receipt and the invoice desk key off this one, so a missing notification
// email can never block booking stock that has actually arrived.
const EFFECTIVE_STATUS_EXPR = `
  CASE
    WHEN po.status IN ('cancelled', 'short_closed', 'received') THEN po.status
    WHEN po.qty > 0 AND ${RECEIVED_TOTAL_EXPR} >= po.qty THEN 'received'
    WHEN ${RECEIVED_TOTAL_EXPR} > 0 AND ${RECEIVED_TOTAL_EXPR} < po.qty THEN 'partially_received'
    ELSE po.status
  END
`

// What PO Tracking shows. A PO isn't really "raised" until the manufacturer has
// been told about it, so a stored-'raised' PO with no send stamp reads back as
// a draft — the mail send (POST /api/purchase-orders/send-mail, which stamps
// email_sent_at) is what promotes it. Layered on top of EFFECTIVE_STATUS_EXPR
// so terminal states and the partial-receipt derivation still win: anything
// received against is self-evidently already out with the manufacturer.
//
// Inward POs are exempt: they're the invoice desk's record of goods that have
// already shipped, there is no procurement mail to send for them, and their
// own notification goes to the receiving warehouse (lib/invoice-inward.ts).
const DISPLAY_STATUS_EXPR = `
  CASE
    WHEN (${EFFECTIVE_STATUS_EXPR}) = 'raised'
     AND po.email_sent_at IS NULL
     AND COALESCE(po.po_type, '') <> 'inward' THEN 'draft'
    ELSE (${EFFECTIVE_STATUS_EXPR})
  END
`

// The FG PO Tracking page never shows inward POs — those are the invoice desk's
// records, not procurement's. Expressed as its own nullable flag rather than
// folded into the po_type filter, which matches on equality and so can't say
// "anything but this". Pass 1 to exclude, null to leave inward POs in.
const EXCLUDE_INWARD = `AND (? IS NULL OR po.po_type <> 'inward')`

// Split children never appear as rows of their own: they belong to their master
// and are reached by expanding it. Taking no parameter — unlike EXCLUDE_INWARD —
// because there is no caller that wants them loose in the list. One fragment,
// shared by both WHEREs, so the table, the COUNT behind pagination, the tab
// badges, the summary cards and the CSV/Excel export all agree by construction.
const MASTERS_ONLY = `AND NOT ${IS_SPLIT_CHILD}`

// Per-user entity scope, appended to both shared WHERE fragments so the PO
// list, the COUNT, the tab badges, the summary cards and the CSV/Excel export
// are all scoped by one edit. Warehouse compares against `destination`, which
// holds master_warehouse.name (there is no FK) — lib/scope.ts resolves ids to
// names for exactly this reason.
// Params: scopeParams(mfgIds) then scopeParams(warehouseNames), i.e. 4 values.
const SCOPE_WHERE = `
    AND (? IS NULL OR po.mfg_id      IN (?))
    AND (? IS NULL OR po.destination IN (?))`

// ── Shared WHERE fragment (all filters) ──────────────────────────────────────
// Params (23): [like×6, status×4, mfgCode×2, poType×2, dateFrom×2, dateTo×2, sku×2, destination×2, excludeInward]
// The status filter matches an IN-list rather than a single value so the
// "received" tab can also pull in short-closed POs and the PO Inwarding page's
// "open" tab can span raised/punched/partially_received — see statusMatchValues().
const FULL_WHERE = `
  WHERE (? IS NULL OR po.po_no LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR po.sku_code LIKE ? OR sk.name LIKE ?)
    AND (? IS NULL OR ${DISPLAY_STATUS_EXPR} IN (?, ?, ?))
    AND (? IS NULL OR m.code         = ?)
    AND (? IS NULL OR po.po_type     = ?)
    AND (? IS NULL OR po.date       >= ?)
    AND (? IS NULL OR po.date       <= ?)
    AND (? IS NULL OR po.sku_code    = ?)
    AND (? IS NULL OR po.destination = ?)
    ${EXCLUDE_INWARD}
    ${MASTERS_ONLY}
    ${SCOPE_WHERE}
`

// Params (19): [like×6, mfgCode×2, poType×2, dateFrom×2, dateTo×2, sku×2, destination×2, excludeInward]
// Used by statusCounts and summaryStats which ignore the status filter.
const SUMMARY_WHERE = `
  WHERE (? IS NULL OR po.po_no LIKE ? OR m.code LIKE ? OR m.name LIKE ? OR po.sku_code LIKE ? OR sk.name LIKE ?)
    AND (? IS NULL OR m.code         = ?)
    AND (? IS NULL OR po.po_type     = ?)
    AND (? IS NULL OR po.date       >= ?)
    AND (? IS NULL OR po.date       <= ?)
    AND (? IS NULL OR po.sku_code    = ?)
    AND (? IS NULL OR po.destination = ?)
    ${EXCLUDE_INWARD}
    ${MASTERS_ONLY}
    ${SCOPE_WHERE}
`

// master_bom is LEFT JOINed even though bulk-created POs now always carry a
// bom_id: every PO raised before that rule, and every one raised from the Add
// PO dialog, still has none.
const FROM_JOINS = `
  FROM purchase_orders po
  INNER JOIN master_mfgs m  ON m.id        = po.mfg_id
  LEFT  JOIN master_skus sk ON sk.sku_code = po.sku_code
  LEFT  JOIN master_bom  b  ON b.id        = po.bom_id
  ${CHILD_AGG_JOIN}
`

const SELECT_COLS = `
  SELECT
    po.id, po.po_no, po.date, po.sku_code, po.qty, po.unit_price,
    po.total_amount, po.expected_on, po.received_qty, po.invoice_no,
    po.uniware_po_code,
    po.destination, ${DISPLAY_STATUS_EXPR} AS status, po.status AS raw_status,
    po.po_type, po.attachment_key,
    po.csv_source_key, po.email_sent_at,
    po.bom_id, b.bom_code,
    po.reference_po,
    COALESCE(ch.child_count, 0)  AS child_count,
    ${ALLOCATED_QTY_EXPR}        AS split_qty,
    ${PENDING_SPLIT_EXPR}        AS pending_split_qty,
    ${RECEIVED_TOTAL_EXPR}       AS received_total,
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
  status:       `(${DISPLAY_STATUS_EXPR})`,
}

export const purchaseOrdersSql = {
  /**
   * All POs joined with manufacturer name, SKU name, and who originally raised
   * each PO. Params: scopeParams(mfgIds) + scopeParams(warehouseNames)
   */
  selectAll: `
    ${SELECT_COLS}
    ${FROM_JOINS}
    WHERE 1 = 1
    ${SCOPE_WHERE}
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
    SELECT ${DISPLAY_STATUS_EXPR} AS status, COUNT(*) AS cnt
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
    GROUP BY ${DISPLAY_STATUS_EXPR}
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

  /**
   * Summary stats for the cards (ignores status param). Quantities, not PO
   * counts: procurement is answerable for how many units are still owed and how
   * much of what was ordered actually landed, and the per-status PO counts are
   * already on the tab badges.
   *
   *   open_qty       units still owed on live POs — cancelled and draft POs owe
   *                  nothing, received/short-closed ones are finished. GREATEST
   *                  clamps over-receipts so one over-delivery can't offset
   *                  another PO's genuine shortfall.
   *   committed_qty  units ordered under a PO the manufacturer is actually
   *                  working on — the fill-rate denominator. Drafts are out
   *                  (nothing was asked for yet) and so are cancellations.
   *   received_qty   units received against those same POs — the numerator.
   *                  Fill rate is left to the caller so a zero denominator
   *                  reads as "no data" rather than as 0%.
   *   overdue_qty    of the open units, how many are already past the date they
   *                  were promised for, over overdue_pos POs. Open qty on its
   *                  own says how much is outstanding but not whether any of it
   *                  is late, which is the part someone has to chase.
   *   draft_pos      POs sitting unraised, i.e. never mailed to the
   *                  manufacturer — the actionable number on this strip.
   *
   * Every row here is a master (SUMMARY_WHERE excludes children), and every
   * received figure is the rolled-up one, so a split PO contributes its full
   * original quantity exactly once no matter how many children it has.
   *
   * Params: buildStatusCountParams(...)  (18 total)
   */
  summaryStats: `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${DISPLAY_STATUS_EXPR} IN ('raised', 'punched', 'partially_received')
               THEN GREATEST(po.qty - ${RECEIVED_TOTAL_EXPR}, 0) ELSE 0 END) AS open_qty,
      SUM(CASE WHEN ${DISPLAY_STATUS_EXPR} NOT IN ('draft', 'cancelled')
               THEN po.qty ELSE 0 END)                        AS committed_qty,
      SUM(CASE WHEN ${DISPLAY_STATUS_EXPR} NOT IN ('draft', 'cancelled')
               THEN ${RECEIVED_TOTAL_EXPR} ELSE 0 END)        AS received_qty,
      SUM(CASE WHEN ${DISPLAY_STATUS_EXPR} IN ('raised', 'punched', 'partially_received')
                AND po.expected_on IS NOT NULL AND po.expected_on < CURDATE()
               THEN GREATEST(po.qty - ${RECEIVED_TOTAL_EXPR}, 0) ELSE 0 END)       AS overdue_qty,
      SUM(${DISPLAY_STATUS_EXPR} IN ('raised', 'punched', 'partially_received')
          AND po.expected_on IS NOT NULL AND po.expected_on < CURDATE())           AS overdue_pos,
      SUM(${DISPLAY_STATUS_EXPR} = 'draft')                                        AS draft_pos
    ${FROM_JOINS}
    ${SUMMARY_WHERE}
  `,

  /** Count of POs with a given po_no prefix — used for brand-scoped PO number generation. Parameters: ['MCA-PO-202606-%'] */
  countByPrefix: `
    SELECT COUNT(*) AS cnt FROM purchase_orders WHERE po_no LIKE ?
  `,

  /**
   * Insert an impromptu PO as draft (pending approval).
   * Parameters: [po_no, mfg_id, sku_code, bom_id, qty, unit_price, total_amount, expected_on, po_type, destination]
   */
  insert: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, bom_id, qty, unit_price, total_amount, expected_on, status, po_type, destination)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `,

  /**
   * Insert a normal PO directly as raised (no approval needed).
   * Parameters: [po_no, mfg_id, sku_code, bom_id, qty, unit_price, total_amount, expected_on, destination]
   */
  insertNormal: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, bom_id, qty, unit_price, total_amount, expected_on, status, po_type, destination)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'raised', 'normal', ?)
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

  /**
   * Stamp the first successful notification send on a set of POs. This is what
   * promotes a PO from Draft to Raised in PO Tracking (see DISPLAY_STATUS_EXPR),
   * so it must only run for ids the mail actually went out for.
   *
   * `email_sent_at IS NULL` keeps it idempotent — re-sending a PO keeps the
   * original send time. Stored drafts are excluded: an impromptu PO still
   * waiting on its approval isn't raised by mailing a copy of it, and stamping
   * it now would silently promote it the moment the approver clicks approve.
   * Params: [...ids]
   */
  buildMarkEmailSent(count: number): string {
    const placeholders = Array(count).fill("?").join(",")
    return `
      UPDATE purchase_orders
      SET email_sent_at = NOW()
      WHERE id IN (${placeholders})
        AND email_sent_at IS NULL
        AND status <> 'draft'
    `
  },

  /**
   * Stamp the Unicommerce PO code on the inward POs an invoice just created —
   * all of them, because Uniware mirrors the whole invoice as one PO. Runs
   * after the mirror succeeds but inside the same transaction, so a row never
   * commits quoting a Uniware PO that doesn't exist.
   * Parameters: [uniware_po_code, ...ids]
   */
  buildSetUniwarePoCode(count: number): string {
    const placeholders = Array(count).fill("?").join(",")
    return `UPDATE purchase_orders SET uniware_po_code = ? WHERE id IN (${placeholders})`
  },

  /** Credit a manual goods-receipt qty to received_qty. Parameters: [qty, id] */
  incrementReceivedQtyManual: `UPDATE purchase_orders SET received_qty = COALESCE(received_qty, 0) + ? WHERE id = ?`,


  /** Fetch MFG name for readable approval diff. Parameters: [id] */
  /**
   * The two columns entity scope is decided on, for a single PO. Used by
   * assertPoInScope (lib/po-guard.ts) before any read or write that addresses a
   * PO by id. Params: [id]
   */
  selectScopeById: `
    SELECT id, mfg_id, destination FROM purchase_orders WHERE id = ? LIMIT 1
  `,

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

  /**
   * Lightweight PO fetch used for status checks and po_no retrieval.
   * received_qty comes along because cancellation is gated on it: a PO with
   * goods already booked against it is short-closed, never cancelled.
   * Parameters: [id]
   */
  selectForEdit: `
    SELECT id, po_no, status, qty, COALESCE(received_qty, 0) AS received_qty
    FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /** Fetch the user who originally submitted this PO. Parameters: [po_id] */
  selectRaisedBy: `
    SELECT raised_by FROM approvals
    WHERE module = 'PO' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `,

  /**
   * Full PO row for split operations. reference_po comes along so the route can
   * refuse to split a child (splits are one level deep), and bom_id so children
   * inherit the recipe the parent was raised against. Parameters: [id]
   */
  selectForSplit: `
    SELECT id, po_no, mfg_id, sku_code, bom_id, qty, unit_price, received_qty,
           expected_on, status, reference_po
    FROM purchase_orders WHERE id = ? LIMIT 1
  `,

  /**
   * A parent's live children, aggregated. Drives the split route's remaining-qty
   * guard and the child PO numbering, so cancelled children are excluded here
   * too: their quantity is back in the pool and their -S suffix is spent.
   * `seq` is the highest suffix ever issued, cancelled ones included, so a
   * re-split can't reuse a number. Params: [po_no, po_no]
   */
  childSplitSummary: `
    SELECT
      COALESCE(SUM(CASE WHEN COALESCE(status, '') <> 'cancelled' THEN qty ELSE 0 END), 0) AS allocated_qty,
      (SELECT COUNT(*) FROM purchase_orders
        WHERE reference_po = ? AND COALESCE(po_type, '') <> 'inward')                     AS seq
    FROM purchase_orders
    WHERE reference_po = ? AND COALESCE(po_type, '') <> 'inward'
  `,

  /** Full PO row for a manual receive operation. Parameters: [id] */
  /** Same as selectForReceive but locks the row for the duration of the transaction — prevents two concurrent receives from both reading a stale received_qty. Parameters: [id] */
  selectForReceiveLocked: `
    SELECT id, po_no, sku_code, qty, received_qty, status
    FROM purchase_orders WHERE id = ? LIMIT 1 FOR UPDATE
  `,

  /**
   * Insert a split child PO with an explicit status. The parent is NOT touched
   * by a split — its qty is the quantity that was legally ordered and never
   * changes — so this insert is the entire write.
   * Parameters: [po_no, mfg_id, sku_code, bom_id, qty, expected_on, status, destination, reference_po]
   */
  insertSplit: `
    INSERT INTO purchase_orders (po_no, mfg_id, date, sku_code, bom_id, qty, expected_on, status, destination, reference_po, po_type)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, 'normal')
  `,

  /**
   * Insert a PO directly as 'raised' for the bulk CSV flow. bom_id is not
   * nullable in practice here — the importer refuses a row whose bom_code it
   * can't resolve — so every bulk-created PO records the recipe it was placed
   * against.
   * Parameters: [po_no, mfg_id, sku_code, bom_id, qty, expected_on, destination, csv_source_key]
   */
  insertBulkPo: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, bom_id, qty, expected_on, status, po_type, destination, csv_source_key)
    VALUES (?, ?, CURDATE(), ?, ?, ?, ?, 'raised', 'normal', ?, ?)
  `,

  /**
   * Resolve a BOM code to the recipe and the SKU it belongs to — the bulk
   * importer's bom_code check. sku_code comes back so the caller can refuse a
   * BOM that belongs to a different SKU than the row claims, which is the
   * mistake this column exists to catch. Params: [bom_code]
   */
  selectBomByCode: `
    SELECT b.id, b.bom_code, b.status, s.sku_code
    FROM master_bom b
    LEFT JOIN master_skus s ON s.id = b.sku_id
    WHERE b.bom_code = ?
    LIMIT 1
  `,

  /** Attach a recipe to a PO that has none. Parameters: [bom_id, id] */
  setBomId: `UPDATE purchase_orders SET bom_id = ? WHERE id = ?`,

  /**
   * The Add PO / Re-edit dialogs' bom_id check: is this recipe both the named
   * SKU's and one this manufacturer actually produces it under? The
   * master_bom_mfg join is the point — it's a stronger statement than the BOM's
   * own status, which is why this path doesn't additionally require 'active'
   * the way the bulk importer does (a CSV can name any mfg/SKU pair, so status
   * is all it has to go on). Params: [mfg_id, bom_id, sku_code]
   */
  selectBomForMfgSku: `
    SELECT b.id, b.bom_code, b.status
    FROM master_bom b
    INNER JOIN master_skus sk     ON sk.id     = b.sku_id
    INNER JOIN master_bom_mfg mbm ON mbm.bom_id = b.id AND mbm.mfg_id = ?
    WHERE b.id = ? AND sk.sku_code = ?
    LIMIT 1
  `,

  /**
   * Update editable fields on a draft PO. bom_id is in the set because the SKU
   * is: an edit that switches SKU would otherwise leave the PO pointing at the
   * old SKU's recipe.
   * Parameters: [mfg_id, sku_code, bom_id, qty, unit_price, total_amount, expected_on, destination, id]
   */
  updateDraft: `
    UPDATE purchase_orders
    SET mfg_id = ?, sku_code = ?, bom_id = ?, qty = ?, unit_price = ?, total_amount = ?,
        expected_on = ?, destination = ?
    WHERE id = ?
  `,

  // ── PO Bulk Upload — create-or-update by po_no, + history_pos audit trail ──

  /**
   * Look up an existing PO by its unique po_no — used by the bulk CSV importer
   * to decide create vs. update. Carries the columns that gate what the
   * importer may then do to it: received_qty (a PO with receipts can't be
   * cancelled), sku_code and bom_id (the row's bom_code has to agree with the
   * PO it names). Params: [po_no]
   */
  selectByPoNo: `
    SELECT id, po_no, status, expected_on, destination, sku_code, bom_id,
           qty, COALESCE(received_qty, 0) AS received_qty
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
   * punched (which has no physical goods behind it yet).
   *
   * Split children ARE listed — the goods physically arrive against the split,
   * so it is the row a receipt books to — and carry reference_po so the picker
   * can say which order each one came off. A master, by contrast, offers only
   * its UNALLOCATED remainder: quantity already handed to a child must not be
   * receivable a second time against the parent, and a fully-allocated master
   * drops out of the picker entirely. Parameters: [mfg_id]
   */
  openForReceiveByMfg: `
    SELECT po.id, po.po_no, po.sku_code, sk.name AS sku_name, po.reference_po,
           po.qty, COALESCE(po.received_qty, 0) AS received_qty,
           ${UNALLOCATED_QTY_EXPR} AS remaining,
           po.expected_on, ${EFFECTIVE_STATUS_EXPR} AS status
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    ${CHILD_AGG_JOIN}
    WHERE po.mfg_id = ?
      AND ${EFFECTIVE_STATUS_EXPR} IN ('raised', 'partially_received')
      AND ${UNALLOCATED_QTY_EXPR} > 0
    ORDER BY po.date DESC, po.id DESC
  `,

  /**
   * The "Remaining Open Purchase Orders" table in the manufacturer mail, and
   * the mfg-batch screen's open-PO panel.
   *
   * `qty` is the UNALLOCATED remainder, not the ordered quantity: a master that
   * has handed 400 of its 1,000 to a split still owes 600 itself, and the split
   * appears on its own line for the other 400. Reporting po.qty here would tell
   * the manufacturer 1,400 units are outstanding. Masters with nothing left
   * unallocated drop out — the children carry the balance. Parameters: [mfg_id]
   */
  ongoingByMfg: `
    SELECT po.id, po.po_no, po.sku_code, sk.name AS sku_name, po.reference_po,
           ${UNALLOCATED_QTY_EXPR} AS qty,
           po.expected_on, ${EFFECTIVE_STATUS_EXPR} AS status
    FROM purchase_orders po
    LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
    ${CHILD_AGG_JOIN}
    WHERE po.mfg_id = ?
      AND ${EFFECTIVE_STATUS_EXPR} NOT IN ('received', 'cancelled')
      AND ${UNALLOCATED_QTY_EXPR} > 0
    ORDER BY po.date DESC, po.id DESC
  `,

  /**
   * Fetch PO + SKU + manufacturer info for an arbitrary set of PO ids —
   * drives the "select POs, review, send mail" flow's grouping-by-manufacturer
   * step. Use buildSelectByIds(count) for the placeholder-count-matched SQL.
   *
   * Deliberately the operational status, not the display one: these rows are
   * about to be mailed, so a stored-'raised' PO with no send stamp still has to
   * come through as "raised" — that's what puts it in the mail's Newly Raised
   * section and attaches its PDF.
   *
   * reference_po and child_count come back so the send can tell the three cases
   * apart: a split child (mailed, under its own section, naming its parent), a
   * master that has been split (not mailable — its children are), and an
   * ordinary PO. Params: [...ids]
   */
  buildSelectByIds(count: number): string {
    const placeholders = Array(count).fill("?").join(",")
    return `
      SELECT po.id, po.po_no, po.mfg_id, m.code AS mfg_code, m.name AS mfg_name,
             po.sku_code, sk.name AS sku_name, po.qty, po.destination,
             po.reference_po, COALESCE(ch.child_count, 0) AS child_count,
             ${EFFECTIVE_STATUS_EXPR} AS status
      FROM purchase_orders po
      INNER JOIN master_mfgs m ON m.id = po.mfg_id
      LEFT JOIN master_skus sk ON sk.sku_code = po.sku_code
      ${CHILD_AGG_JOIN}
      WHERE po.id IN (${placeholders})
    `
  },

  /**
   * Every split child of a page of masters, for the expandable section under
   * each row. Fetched in one round trip per page rather than lazily per row:
   * splits are few, and a spinner inside a table row costs more than the query.
   * Same column list as the main list so a child renders with the same cells.
   * Params: [...parent po_nos]
   */
  buildSelectChildren(count: number): string {
    const placeholders = Array(count).fill("?").join(",")
    return `
      ${SELECT_COLS}
      ${FROM_JOINS}
      WHERE po.reference_po IN (${placeholders})
        AND COALESCE(po.po_type, '') <> 'inward'
      ORDER BY po.po_no ASC
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
 * Build the 27-element param array for selectPaginated / countPaginated.
 * All-null values disable the corresponding filter.
 *
 * `excludeInward` is the FG PO Tracking page's standing filter — true there,
 * false on PO Inwarding, which is where inward POs belong.
 *
 * `scope` is REQUIRED rather than defaulting to unrestricted: an omitted scope
 * would silently show every manufacturer's POs, so the compiler flags any new
 * caller that forgets it. Pass UNRESTRICTED explicitly if that's genuinely
 * intended.
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
  excludeInward = false,
  scope:       UserScope,
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
    excludeInward ? 1 : null,           // excludeInward ×1
    ...scopeParams(scope.mfgIds),         // entity scope: mfg ×2
    ...scopeParams(scope.warehouseNames), // entity scope: warehouse ×2
  ]
}

/**
 * Build the 23-element param array for statusCounts / summaryStats
 * (same as buildFilterParams but without the status filter quad).
 */
export function buildStatusCountParams(
  search:      string | null,
  mfgCode:     string | null,
  poType:      string | null,
  dateFrom:    string | null,
  dateTo:      string | null,
  sku:         string | null,
  destination: string | null,
  excludeInward = false,
  scope:       UserScope,
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
    excludeInward ? 1 : null,           // excludeInward ×1
    ...scopeParams(scope.mfgIds),         // entity scope: mfg ×2
    ...scopeParams(scope.warehouseNames), // entity scope: warehouse ×2
  ]
}
