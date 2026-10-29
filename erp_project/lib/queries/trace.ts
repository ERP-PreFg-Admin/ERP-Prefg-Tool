// SQL behind the traceability datasets (docs/reporting/dataset-contracts.md). Straight joins only:
// every hop below is 1:1 from the row's own grain, and anything N-valued is a scalar subquery.

import { scopeParams, type UserScope } from "@/lib/scope"
import {
  APPROVED_ONLY, CHILD_AGG_JOIN, DISPLAY_STATUS_EXPR, IS_SPLIT_CHILD, MASTERS_ONLY, PO_SKU_NAME, RECEIVED_TOTAL_EXPR, SCOPE_WHERE,
} from "@/lib/queries/purchase-orders"

/** SQL twin of batchKey() in lib/reports/trace/normalise.ts. */
export const batchKeySql = (col: string) =>
  `COALESCE(NULLIF(UPPER(REGEXP_REPLACE(COALESCE(${col}, ''), '[[:space:]./_-]', '')), ''), '(no batch)')`

const IST = (col: string) => `CONVERT_TZ(${col}, '+00:00', '+05:30')`

export type TraceFilters = {
  mfgCode: string | null
  skuCode: string | null
  /** A procurement PO (master or split child) or an inward PO number. */
  poNo: string | null
  invoiceNo: string | null
  /** Match invoiceNo exactly instead of "contains" (row expand pins one invoice). */
  invoiceExact?: boolean
  /** Already a batch key (batchKey()). */
  batchKey: string | null
  /** Inwarded date, IST, inclusive. */
  dateFrom: string | null
  dateTo: string | null
  /** Destination warehouse name (invoice destination; PO destination on the PO-side datasets). */
  destination?: string | null
}

/** Shared param order: mfg×2, sku×2, po×4, invoice×2, batch×2, from×2, to×2, destination×2, then mfg / destination / brand scope. */
export function buildTraceParams(f: TraceFilters, scope: UserScope): unknown[] {
  const escaped = f.invoiceNo?.replace(/[\\%_]/g, "\\$&")
  const inv = !escaped ? null : f.invoiceExact ? escaped : `%${escaped}%`
  return [
    f.mfgCode, f.mfgCode,
    f.skuCode, f.skuCode,
    f.poNo, f.poNo, f.poNo, f.poNo,
    inv, inv,
    f.batchKey, f.batchKey,
    f.dateFrom, f.dateFrom,
    f.dateTo, f.dateTo,
    f.destination ?? null, f.destination ?? null,
    ...scopeParams(scope.mfgIds), ...scopeParams(scope.warehouseNames), ...scopeParams(scope.brandIds),
  ]
}

// ── T1 PO ↔ invoice line map ────────────────────────────────────────────────

const T1_FROM = `
  FROM invoice_items_mfg sii
  INNER JOIN invoice_mfg si   ON si.id = sii.invoice_id
  INNER JOIN master_mfgs m    ON m.id  = si.mfg_id
  LEFT  JOIN master_skus sk   ON sk.sku_code = sii.sku_code
  LEFT  JOIN master_brand br  ON br.id = sk.brand_id
  LEFT  JOIN master_entity e  ON e.pan = SUBSTRING(si.buyer_gstin, 3, 10)
  LEFT  JOIN purchase_orders po  ON po.id  = sii.received_against_po_id
  LEFT  JOIN purchase_orders inw ON inw.id = sii.po_id
  ${CHILD_AGG_JOIN}
`
const T1_WHERE = `
  WHERE (? IS NULL OR m.code = ?)
    AND (? IS NULL OR sii.sku_code = ?)
    AND (? IS NULL OR po.po_no = ? OR po.reference_po = ? OR inw.po_no = ?)
    AND (? IS NULL OR si.invoice_no LIKE ?)
    AND (? IS NULL OR ${batchKeySql("sii.batch")} = ?)
    AND (? IS NULL OR DATE(${IST("si.created_at")}) >= ?)
    AND (? IS NULL OR DATE(${IST("si.created_at")}) <= ?)
    AND (? IS NULL OR si.destination = ?)
    AND (? IS NULL OR si.mfg_id IN (?))
    AND (? IS NULL OR si.destination IN (?))
    AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
`

// ── T5 GRN line dump ────────────────────────────────────────────────────────

const T5_FROM = `
  FROM grn_items_uniware gi
  INNER JOIN grn_uniware g    ON g.id  = gi.grn_id
  LEFT  JOIN invoice_mfg si   ON si.id = g.invoice_id
  LEFT  JOIN master_mfgs m    ON m.id  = si.mfg_id
  LEFT  JOIN master_skus sk   ON sk.sku_code = gi.sku_code
  LEFT  JOIN purchase_orders inw ON inw.id = gi.po_id
`
const T5_WHERE = `
  WHERE (? IS NULL OR m.code = ?)
    AND (? IS NULL OR gi.sku_code = ?)
    AND (? IS NULL OR inw.po_no = ? OR EXISTS (
          SELECT 1 FROM invoice_items_mfg x JOIN purchase_orders p ON p.id = x.received_against_po_id
          WHERE x.invoice_id = g.invoice_id AND x.sku_code = gi.sku_code AND (p.po_no = ? OR p.reference_po = ?)))
    AND (? IS NULL OR si.invoice_no LIKE ?)
    AND (? IS NULL OR ${batchKeySql("gi.batch_code")} = ?)
    AND (? IS NULL OR DATE(${IST("si.created_at")}) >= ?)
    AND (? IS NULL OR DATE(${IST("si.created_at")}) <= ?)
    AND (? IS NULL OR si.destination = ?)
    AND (? IS NULL OR si.mfg_id IN (?))
    AND (? IS NULL OR si.destination IN (?))
    AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
`

// ── T3 / T4: procurement-PO side ────────────────────────────────────────────

const PO_FROM = `
  FROM purchase_orders po
  INNER JOIN master_mfgs m   ON m.id = po.mfg_id
  LEFT  JOIN master_skus sk  ON sk.sku_code = po.sku_code
  LEFT  JOIN master_brand br ON br.id = sk.brand_id
  ${CHILD_AGG_JOIN}
`
// Approved non-inward POs, masters and split children each a row. Same param order as buildTraceParams;
// invoice, batch and inward PO match through the PO's own lines.
const PO_WHERE = `
  WHERE COALESCE(po.po_type, '') <> 'inward'
    ${APPROVED_ONLY}
    AND (? IS NULL OR m.code = ?)
    AND (? IS NULL OR po.sku_code = ?)
    AND (? IS NULL OR po.po_no = ? OR po.reference_po = ? OR EXISTS (
          SELECT 1 FROM invoice_items_mfg x JOIN purchase_orders i ON i.id = x.po_id
          WHERE x.received_against_po_id = po.id AND i.po_no = ?))
    AND (? IS NULL OR EXISTS (
          SELECT 1 FROM invoice_items_mfg x JOIN invoice_mfg s ON s.id = x.invoice_id
          WHERE x.received_against_po_id = po.id AND s.invoice_no LIKE ?))
    AND (? IS NULL OR EXISTS (
          SELECT 1 FROM invoice_items_mfg x
          WHERE x.received_against_po_id = po.id AND ${batchKeySql("x.batch")} = ?))
    AND (? IS NULL OR po.date >= ?)
    AND (? IS NULL OR po.date <= ?)
    AND (? IS NULL OR po.destination = ?)
    ${SCOPE_WHERE}
`

// Live invoice qty per master PO, split children's lines rolled up to their master (one pass, not per PO).
const T6_LINES = `
  SELECT CASE WHEN p.reference_po IS NOT NULL AND COALESCE(p.po_type, '') <> 'inward' THEN p.reference_po ELSE p.po_no END AS master_no,
         SUM(x.qty) AS invoiced_qty
  FROM invoice_items_mfg x
  JOIN invoice_mfg s ON s.id = x.invoice_id AND s.reverted_at IS NULL
  JOIN purchase_orders p ON p.id = x.received_against_po_id
`

const GRN_SYNCED_AT =`(SELECT MAX(gs.synced_at) FROM grn_uniware gs WHERE gs.invoice_id = si.id)`

export const traceSql = {
  /** Params: [...buildTraceParams, limit, offset]. */
  t1Rows: `
    SELECT
      sii.id AS line_id, si.id AS invoice_id, si.invoice_no, si.invoice_date, si.created_at AS inwarded_at,
      si.reverted_at, m.code AS mfg_code, m.name AS mfg_name, si.destination, e.code AS entity_code,
      si.uniware_po_code, si.uniware_status, ${GRN_SYNCED_AT} AS grn_synced_at,
      (SELECT MIN(gf.grn_created_at) FROM grn_uniware gf WHERE gf.invoice_id = si.id) AS first_grn_at,
      sii.line_no, sii.sku_code, COALESCE(NULLIF(TRIM(sk.supply_name), ''), sk.name, sii.sku_name) AS sku_name,
      sii.parsed_sku_code AS vendor_sku, br.name AS brand, sii.hsn,
      sii.batch, sii.mfg_date, sii.expiry, sii.qty, sii.rate, sii.mrp, sii.discount, sii.gst_percent AS gst_pct,
      sii.amount AS taxable_value, sii.link_type,
      (SELECT COUNT(*) FROM invoice_items_mfg x
        WHERE x.invoice_id = sii.invoice_id AND x.sku_code = sii.sku_code
          AND ${batchKeySql("x.batch")} = ${batchKeySql("sii.batch")}
          AND COALESCE(TRIM(x.expiry), '') = COALESCE(TRIM(sii.expiry), '')
          AND x.rate <=> sii.rate) AS printed_line_rows,
      po.id AS po_id, po.po_no, po.po_type, po.date AS po_date, po.qty AS po_qty, po.unit_price AS po_rate,
      po.sku_code AS po_sku_code,
      CASE WHEN po.reference_po IS NOT NULL AND COALESCE(po.po_type, '') <> 'inward' THEN po.reference_po ELSE po.po_no END
        AS master_po_no,
      CASE WHEN po.id IS NULL THEN NULL ELSE (${DISPLAY_STATUS_EXPR}) END AS po_status,
      inw.id AS inward_po_id, inw.po_no AS inward_po_no, inw.status AS inward_status,
      inw.un_qc_pass_qty, inw.un_pending_qty
    ${T1_FROM}
    ${T1_WHERE}
    ORDER BY si.created_at DESC, si.id DESC, sii.line_no ASC
    LIMIT ? OFFSET ?
  `,
  /** Params: buildTraceParams. */
  t1Count: `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN si.reverted_at IS NULL THEN sii.qty END), 0) AS live_qty ${T1_FROM} ${T1_WHERE}`,

  /** Params: [...buildTraceParams, limit, offset]. */
  t5Rows: `
    SELECT
      g.grn_code, gi.line_no AS grn_line_no, g.status_code AS grn_status, g.grn_created_at, g.facility_code,
      g.vendor_invoice_no, si.id AS invoice_id, si.invoice_no, si.reverted_at, g.uniware_po_code,
      m.code AS mfg_code, m.name AS mfg_name,
      gi.sku_code, COALESCE(NULLIF(TRIM(sk.supply_name), ''), sk.name) AS sku_name,
      gi.batch_code AS batch, gi.expiry, gi.mfg_date,
      gi.quantity AS gross_qty, gi.rejected_qty,
      inw.id AS inward_po_id, inw.po_no AS inward_po_no,
      (SELECT GROUP_CONCAT(DISTINCT p.po_no ORDER BY p.po_no SEPARATOR ', ')
         FROM invoice_items_mfg x JOIN purchase_orders p ON p.id = x.received_against_po_id
        WHERE x.invoice_id = g.invoice_id AND x.sku_code = gi.sku_code) AS procurement_po_nos,
      (SELECT SUM(x.qty) FROM invoice_items_mfg x
        WHERE x.invoice_id = g.invoice_id AND x.sku_code = gi.sku_code) AS billed_qty_for_sku,
      g.synced_at AS grn_synced_at
    ${T5_FROM}
    ${T5_WHERE}
    ORDER BY g.grn_created_at DESC, g.grn_code, gi.line_no
    LIMIT ? OFFSET ?
  `,
  /** T2 input: live invoice lines matching the filters. Params: buildTraceParams. */
  t2Lines: `
    SELECT sii.invoice_id, sii.sku_code, COALESCE(NULLIF(TRIM(sk.supply_name), ''), sk.name, sii.sku_name) AS sku_name,
           sii.batch, sii.expiry, sii.qty, sii.amount AS taxable
    ${T1_FROM}
    ${T1_WHERE}
      AND si.reverted_at IS NULL
  `,
  /** T2 input: GRN lines of live invoices matching the filters. Params: buildTraceParams. */
  t2Grn: `
    SELECT g.invoice_id, g.grn_code, gi.sku_code, COALESCE(NULLIF(TRIM(sk.supply_name), ''), sk.name) AS sku_name,
           gi.batch_code, gi.expiry, gi.quantity, gi.rejected_qty, gi.po_id, g.grn_created_at
    ${T5_FROM}
    ${T5_WHERE}
      AND g.invoice_id IS NOT NULL AND si.reverted_at IS NULL
  `,
  /** T2 heads for the invoices either side touched. Params: [ids]. */
  t2Heads: `
    SELECT si.id AS invoice_id, si.invoice_no, m.code AS mfg_code, m.name AS mfg_name, si.destination,
           si.created_at AS inwarded_at, ${GRN_SYNCED_AT} AS grn_synced_at,
           EXISTS (SELECT 1 FROM grn_uniware gx WHERE gx.invoice_id = si.id) AS has_grn
    FROM invoice_mfg si INNER JOIN master_mfgs m ON m.id = si.mfg_id
    WHERE si.id IN (?)
  `,

  /** T3: one row per procurement PO (masters and split children). Params: [...buildTraceParams, limit, offset]. */
  t3Rows: `
    SELECT
      po.id AS po_id, po.po_no,
      CASE WHEN ${IS_SPLIT_CHILD} THEN po.reference_po ELSE po.po_no END AS master_po_no,
      ${IS_SPLIT_CHILD} AS is_split_child,
      po.po_type, po.date AS po_date, po.expected_on, po.destination,
      m.code AS mfg_code, m.name AS mfg_name, po.sku_code, ${PO_SKU_NAME} AS sku_name, br.name AS brand,
      (${DISPLAY_STATUS_EXPR}) AS status, po.qty,
      COALESCE(po.received_qty, 0) AS received_own,
      CASE WHEN ${IS_SPLIT_CHILD} THEN NULL ELSE ${RECEIVED_TOTAL_EXPR} END AS received_incl_children,
      COALESCE(li.live_qty, 0) AS invoiced_live,
      COALESCE(li.reverted_qty, 0) AS invoiced_reverted,
      COALESCE(li.invoice_count, 0) AS invoice_count,
      COALESCE(hs.sum_delta, 0) AS history_delta,
      hs.first_at AS first_receipt_at, hs.last_at AS last_receipt_at,
      EXISTS (SELECT 1 FROM history_pos hc WHERE hc.po_id = po.id AND hc.action_type = 'create') AS has_create_row
    ${PO_FROM}
    LEFT JOIN (
      SELECT x.received_against_po_id AS pid,
             SUM(CASE WHEN s.reverted_at IS NULL THEN x.qty END)     AS live_qty,
             SUM(CASE WHEN s.reverted_at IS NOT NULL THEN x.qty END) AS reverted_qty,
             COUNT(DISTINCT CASE WHEN s.reverted_at IS NULL THEN s.id END) AS invoice_count
      FROM invoice_items_mfg x JOIN invoice_mfg s ON s.id = x.invoice_id
      WHERE x.received_against_po_id IS NOT NULL
      GROUP BY x.received_against_po_id
    ) li ON li.pid = po.id
    LEFT JOIN (
      SELECT h.po_id,
             SUM(CAST(h.new_value AS DECIMAL(14,3)) - CAST(COALESCE(NULLIF(h.old_value, ''), '0') AS DECIMAL(14,3))) AS sum_delta,
             MIN(h.changed_on) AS first_at, MAX(h.changed_on) AS last_at
      FROM history_pos h WHERE h.field_name = 'received_qty'
      GROUP BY h.po_id
    ) hs ON hs.po_id = po.id
    ${PO_WHERE}
    ORDER BY po.date DESC, po.id DESC
    LIMIT ? OFFSET ?
  `,
  /** Params: buildTraceParams. */
  t3Count: `SELECT COUNT(*) AS total ${PO_FROM} ${PO_WHERE}`,

  /** T4: received_qty history rows of the filtered POs. Params: buildTraceParams. */
  t4Events: `
    SELECT h.id AS history_id, h.po_id, po.po_no,
           CASE WHEN ${IS_SPLIT_CHILD} THEN po.reference_po ELSE po.po_no END AS master_po_no,
           h.changed_on, h.changed_by, u.name AS changed_by_name,
           CAST(COALESCE(NULLIF(h.old_value, ''), '0') AS DECIMAL(14,3)) AS old_qty,
           CAST(h.new_value AS DECIMAL(14,3)) AS new_qty,
           EXISTS (SELECT 1 FROM history_pos r WHERE r.po_id = h.po_id AND r.field_name = 'revert_reason'
                     AND ABS(TIMESTAMPDIFF(SECOND, r.changed_on, h.changed_on)) <= 2) AS revert_nearby
    FROM history_pos h
    INNER JOIN purchase_orders po ON po.id = h.po_id
    INNER JOIN master_mfgs m   ON m.id = po.mfg_id
    LEFT  JOIN master_skus sk  ON sk.sku_code = po.sku_code
    LEFT  JOIN master_brand br ON br.id = sk.brand_id
    LEFT  JOIN users u         ON u.id = h.changed_by
    ${CHILD_AGG_JOIN}
    ${PO_WHERE}
      AND h.field_name = 'received_qty'
    ORDER BY h.changed_on DESC, h.id DESC
  `,
  /** T4: every invoice line (live or reverted) against these POs, for matching. Params: [poIds]. */
  t4Lines: `
    SELECT x.id AS line_id, x.invoice_id, s.invoice_no, x.received_against_po_id AS po_id, x.qty, s.created_at
    FROM invoice_items_mfg x JOIN invoice_mfg s ON s.id = x.invoice_id
    WHERE x.received_against_po_id IN (?)
  `,

  /**
   * T6 input: one row per ordered master (PO-02's set), its invoiced qty with split children rolled in,
   * and the live invoices / batch keys behind it. Params: buildTraceParams.
   */
  t6Masters: `
    SELECT po.id, po.po_no, po.sku_code, ${PO_SKU_NAME} AS sku_name, br.name AS brand, m.code AS mfg_code, m.name AS mfg_name,
           DATE_FORMAT(po.date, '%Y-%m') AS month, po.qty,
           ${RECEIVED_TOTAL_EXPR} AS received_qty, (${DISPLAY_STATUS_EXPR}) AS status,
           COALESCE(inv.invoiced_qty, 0) AS invoiced_qty
    ${PO_FROM}
    LEFT JOIN (${T6_LINES} GROUP BY master_no) inv ON inv.master_no = po.po_no
    ${PO_WHERE}
      ${MASTERS_ONLY}
      AND (${DISPLAY_STATUS_EXPR}) NOT IN ('draft', 'cancelled', 'reverted', 'discarded')
  `,
  /** T6 input: each master's distinct live invoices and batch keys (rows, not GROUP_CONCAT, so nothing truncates). Params: [masterPoNos]. */
  t6Links: `
    SELECT DISTINCT t.master_no, t.invoice_id, t.batch_key
    FROM (
      SELECT CASE WHEN p.reference_po IS NOT NULL AND COALESCE(p.po_type, '') <> 'inward' THEN p.reference_po ELSE p.po_no END AS master_no,
             s.id AS invoice_id, ${batchKeySql("x.batch")} AS batch_key
      FROM invoice_items_mfg x
      JOIN invoice_mfg s ON s.id = x.invoice_id AND s.reverted_at IS NULL
      JOIN purchase_orders p ON p.id = x.received_against_po_id
    ) t
    WHERE t.master_no IN (?)
  `,
  /** T6 input: GRN lines of the given invoices. Params: [invoiceIds]. */
  t6Grn: `
    SELECT g.invoice_id, gi.sku_code, gi.quantity, gi.rejected_qty
    FROM grn_items_uniware gi JOIN grn_uniware g ON g.id = gi.grn_id
    WHERE g.invoice_id IN (?)
  `,

  // ── PO timeline (views-plan B7). Callers check scope first, via t3Rows. ────
  /** Params: [po_no]. */
  timelinePo: `
    SELECT po.id, po.po_no, po.date AS po_date, po.email_sent_at, po.status, po.reference_po, po.po_type, po.qty
    FROM purchase_orders po WHERE po.po_no = ? LIMIT 1
  `,
  /** Approvals on this PO (raise, draft edit). Params: [po_id]. */
  timelineApprovals: `
    SELECT a.module, a.status, a.raised_on, a.approved_on, ru.name AS raised_by, au.name AS approved_by
    FROM approvals a
    LEFT JOIN users ru ON ru.id = a.raised_by
    LEFT JOIN users au ON au.id = a.approved_by
    WHERE a.entity_id = ? AND a.module IN ('PO', 'PO_EDIT')
    ORDER BY a.raised_on
  `,
  /** Every history_pos row on this PO. Params: [po_id]. */
  timelineHistory: `
    SELECT h.id, h.action_type, h.field_name, h.old_value, h.new_value, h.changed_on, u.name AS changed_by
    FROM history_pos h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.po_id = ? ORDER BY h.changed_on, h.id
  `,
  /** Invoices booked against this PO or its split children. Params: [po_id, po_no]. */
  timelineInvoices: `
    SELECT s.id AS invoice_id, s.invoice_no, s.created_at, s.reverted_at, p.po_no AS against_po_no, SUM(x.qty) AS qty
    FROM invoice_items_mfg x
    JOIN invoice_mfg s ON s.id = x.invoice_id
    JOIN purchase_orders p ON p.id = x.received_against_po_id
    WHERE p.id = ? OR (p.reference_po = ? AND COALESCE(p.po_type, '') <> 'inward')
    GROUP BY s.id, s.invoice_no, s.created_at, s.reverted_at, p.po_no
  `,
  /** GRNs of those invoices. Params: [invoice_ids]. */
  timelineGrns: `
    SELECT g.grn_code, g.invoice_id, g.grn_created_at, g.total_qty, g.total_rejected_qty
    FROM grn_uniware g WHERE g.invoice_id IN (?)
  `,

  /** Trace page: what a typed key is. Params: [key]. */
  isPoNo: "SELECT 1 AS x FROM purchase_orders WHERE po_no = ? LIMIT 1",
  isInvoiceNo: "SELECT 1 AS x FROM invoice_mfg WHERE invoice_no = ? LIMIT 1",
  isSkuCode: "SELECT 1 AS x FROM master_skus WHERE sku_code = ? LIMIT 1",

  /** Params: buildTraceParams. */
  t5Count: `SELECT COUNT(*) AS total, COALESCE(SUM(gi.quantity), 0) AS gross_qty ${T5_FROM} ${T5_WHERE}`,
}
