// SQL behind /reports. Reuses the PO building blocks so a report reconciles with PO Tracking by construction.
// Definitions: docs/reporting/implementation-plan.md and lib/reports/definitions.ts.

import { scopeParams, type UserScope } from "@/lib/scope"
import {
  APPROVED_ONLY, CHILD_AGG_JOIN, DISPLAY_STATUS_EXPR, MASTERS_ONLY, PO_SKU_NAME, RECEIVED_TOTAL_EXPR, SCOPE_WHERE,
} from "@/lib/queries/purchase-orders"
import { OPEN_STATUSES, PRICE_CLASS_SQL } from "@/lib/reports/definitions"
import { DQ_CHECK_IDS, type DqCheckId } from "@/lib/reports/dq-checks"

// ── PO-01 Open PO book ───────────────────────────────────────────────────────

const OPEN_QTY = `GREATEST(po.qty - ${RECEIVED_TOTAL_EXPR}, 0)`
const OPEN_PRE_GST = `CASE WHEN (${PRICE_CLASS_SQL}) = 'priced' THEN ${OPEN_QTY} * po.unit_price END`
const OPEN_INCL_GST = `(${OPEN_PRE_GST}) * (1 + COALESCE(sk.gst, 0) / 100)`

const OPEN_PO_FROM = `
  FROM purchase_orders po
  INNER JOIN master_mfgs  m  ON m.id        = po.mfg_id
  LEFT  JOIN master_skus  sk ON sk.sku_code = po.sku_code
  LEFT  JOIN master_brand br ON br.id       = sk.brand_id
  ${CHILD_AGG_JOIN}
`

// Params (18 + 6 scope, via buildOpenPoParams): like×6, mfg×2, dest×2, type×2, overdue×2, from×2, to×2, class×2.
const OPEN_PO_WHERE = `
  WHERE COALESCE(po.po_type, '') <> 'inward'
    ${MASTERS_ONLY}
    ${APPROVED_ONLY}
    AND (${DISPLAY_STATUS_EXPR}) IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(", ")})
    AND ${OPEN_QTY} > 0
    AND (? IS NULL OR po.po_no LIKE ? OR po.sku_code LIKE ? OR CONCAT_WS(' ', sk.name, sk.supply_name) LIKE ? OR m.code LIKE ? OR m.name LIKE ?)
    AND (? IS NULL OR m.code         = ?)
    AND (? IS NULL OR po.destination = ?)
    AND (? IS NULL OR po.po_type     = ?)
    AND (? IS NULL OR (po.expected_on IS NOT NULL AND po.expected_on < ?))
    AND (? IS NULL OR po.date >= ?)
    AND (? IS NULL OR po.date <= ?)
    AND (? IS NULL OR (${PRICE_CLASS_SQL}) = ?)
    ${SCOPE_WHERE}
`

// Each key is [expr, followsDir]; a false entry is a fixed "NULLs last" term.
export const OPEN_PO_SORTS: Record<string, [string, boolean][]> = {
  expected_on: [["po.expected_on IS NULL", false], ["po.expected_on", true]],
  date:        [["po.date", true]],
  open_qty:    [[OPEN_QTY, true]],
  open_value:  [[`(${OPEN_PRE_GST}) IS NULL`, false], [OPEN_PRE_GST, true]],
  mfg:         [["m.code", true]],
  po_no:       [["po.po_no", true]],
}

export type OpenPoFilters = {
  search: string | null
  mfgCode: string | null
  destination: string | null
  poType: string | null
  /** IST today when "overdue only" is on, else null. */
  overdueBefore: string | null
  dateFrom: string | null
  dateTo: string | null
  priceClass: string | null
}

export function buildOpenPoParams(f: OpenPoFilters, scope: UserScope): unknown[] {
  const like = f.search ? `%${f.search}%` : null
  return [
    like, like, like, like, like, like,
    f.mfgCode, f.mfgCode,
    f.destination, f.destination,
    f.poType, f.poType,
    f.overdueBefore, f.overdueBefore,
    f.dateFrom, f.dateFrom,
    f.dateTo, f.dateTo,
    f.priceClass, f.priceClass,
    ...scopeParams(scope.mfgIds), ...scopeParams(scope.warehouseNames), ...scopeParams(scope.brandIds),
  ]
}

// ── PO-02 Manufacturer fill rate ─────────────────────────────────────────────

// First live (non-reverted) invoice receipt per master, children's receipts rolled up to it.
const FIRST_RECEIPT_JOIN = `
  LEFT JOIN (
    SELECT CASE WHEN p.reference_po IS NOT NULL AND COALESCE(p.po_type, '') <> 'inward'
                THEN p.reference_po ELSE p.po_no END AS master_no,
           MIN(im.created_at) AS first_receipt_at
    FROM invoice_items_mfg ii
    INNER JOIN invoice_mfg im     ON im.id = ii.invoice_id AND im.reverted_at IS NULL
    INNER JOIN purchase_orders p  ON p.id  = ii.received_against_po_id
    GROUP BY master_no
  ) fr ON fr.master_no = po.po_no
`
const FIRST_RECEIPT_ON = `DATE(CONVERT_TZ(fr.first_receipt_at, '+00:00', '+05:30'))`

export type FillRateFilters = { dateFrom: string; dateTo: string; mfgCode: string | null; poType: string | null }

export function buildFillRateParams(f: FillRateFilters, scope: UserScope): unknown[] {
  return [
    f.dateFrom, f.dateTo,
    f.mfgCode, f.mfgCode,
    f.poType, f.poType,
    ...scopeParams(scope.mfgIds), ...scopeParams(scope.warehouseNames), ...scopeParams(scope.brandIds),
  ]
}

// ── INV-01 Invoice exceptions / INV-02 Invoice rate vs PO rate ───────────────

// Strict per-line brand scope: hidden if ANY branded line is outside the viewer's brands,
// because invoice-level totals would otherwise expose that brand's value. Params: scopeParams(brandIds).
const INVOICE_BRAND_SCOPE = `
  AND (? IS NULL OR NOT EXISTS (
        SELECT 1 FROM invoice_items_mfg bi
        JOIN master_skus bs ON bs.sku_code = bi.sku_code
        WHERE bi.invoice_id = si.id AND bs.brand_id IS NOT NULL AND bs.brand_id NOT IN (?)))
`

export type InvoiceFilters = {
  search: string | null
  mfgCode: string | null
  destination: string | null
  dateFrom: string | null
  dateTo: string | null
}

// Params: like×3, mfg×2, dest×2, from×2, to×2, then mfg / destination / brand scope.
const INVOICE_FILTERS = `
  WHERE si.reverted_at IS NULL
    AND (? IS NULL OR si.invoice_no LIKE ? OR m.name LIKE ?)
    AND (? IS NULL OR m.code = ?)
    AND (? IS NULL OR si.destination = ?)
    AND (? IS NULL OR DATE(CONVERT_TZ(si.created_at, '+00:00', '+05:30')) >= ?)
    AND (? IS NULL OR DATE(CONVERT_TZ(si.created_at, '+00:00', '+05:30')) <= ?)
    AND (? IS NULL OR si.mfg_id IN (?))
    AND (? IS NULL OR si.destination IN (?))
`

export function buildInvoiceParams(f: InvoiceFilters, scope: UserScope): unknown[] {
  const like = f.search ? `%${f.search}%` : null
  return [
    like, like, like,
    f.mfgCode, f.mfgCode,
    f.destination, f.destination,
    f.dateFrom, f.dateFrom,
    f.dateTo, f.dateTo,
    ...scopeParams(scope.mfgIds), ...scopeParams(scope.warehouseNames), ...scopeParams(scope.brandIds),
  ]
}

/** INV-02 rows are lines, so brand is checked on the line itself. Same params as buildInvoiceParams. */
const RATE_LINE_WHERE = `
  ${INVOICE_FILTERS}
    AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
    AND (${PRICE_CLASS_SQL}) = 'priced'
`
const RATE_DIFF = `(ii.rate - po.unit_price)`
const RATE_DIFF_PCT = `(${RATE_DIFF} / po.unit_price * 100)`

// ── DQ-01 Data quality ───────────────────────────────────────────────────────
// Every check returns the same row shape (ref, label, sub, detail) so one table renders them all.

type DqScope = "po" | "sku" | "map" | "invoice"
type DqDef = { scope: DqScope; from: string; where: string; select: string; order: string }

const DQ_PO_FROM = `
  FROM purchase_orders po
  INNER JOIN master_mfgs m  ON m.id        = po.mfg_id
  LEFT  JOIN master_skus sk ON sk.sku_code = po.sku_code
  ${CHILD_AGG_JOIN}
`
const DQ_PO_LIVE = `
  WHERE COALESCE(po.po_type, '') <> 'inward'
    ${MASTERS_ONLY}
    ${APPROVED_ONLY}
    AND (${DISPLAY_STATUS_EXPR}) NOT IN ('cancelled', 'reverted')
`
const DQ_PO_SELECT = `po.po_no AS ref, CONCAT(m.code, ' · ', COALESCE(po.sku_code, '—')) AS label,
  DATE_FORMAT(po.date, '%Y-%m-%d') AS sub`

const DQ_DEFS: Record<DqCheckId, DqDef> = {
  po_unpriced: {
    scope: "po", from: DQ_PO_FROM, order: "po.date DESC, po.id DESC",
    where: `${DQ_PO_LIVE} AND (${PRICE_CLASS_SQL}) = 'unpriced'`,
    select: `${DQ_PO_SELECT}, CONCAT('qty ', po.qty, ' · ', (${DISPLAY_STATUS_EXPR})) AS detail`,
  },
  po_pre_gst_missing: {
    scope: "po", from: DQ_PO_FROM, order: "po.date DESC, po.id DESC",
    where: `${DQ_PO_LIVE} AND (${PRICE_CLASS_SQL}) = 'priced' AND po.amount_pre_gst IS NULL`,
    select: `${DQ_PO_SELECT}, CONCAT('total ', COALESCE(po.total_amount, 'NULL'), ' · rate × qty ', po.unit_price * po.qty) AS detail`,
  },
  po_total_flip: {
    scope: "po", from: DQ_PO_FROM, order: "po.date DESC, po.id DESC",
    where: `${DQ_PO_LIVE} AND po.amount_pre_gst > 0 AND COALESCE(po.total_amount, 0) = 0`,
    select: `${DQ_PO_SELECT}, CONCAT('pre-GST ', po.amount_pre_gst, ' · total ', COALESCE(po.total_amount, 'NULL')) AS detail`,
  },
  po_bad_destination: {
    scope: "po", from: `${DQ_PO_FROM} LEFT JOIN master_warehouse dw ON dw.name = po.destination`,
    order: "po.date DESC, po.id DESC",
    where: `${DQ_PO_LIVE}
      AND (${DISPLAY_STATUS_EXPR}) IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(", ")})
      AND (TRIM(COALESCE(po.destination, '')) = '' OR dw.id IS NULL)`,
    select: `${DQ_PO_SELECT}, CONCAT('destination: ', COALESCE(NULLIF(TRIM(po.destination), ''), '(blank)')) AS detail`,
  },
  sku_no_gst: {
    scope: "sku", from: "FROM master_skus sk", order: "sk.sku_code",
    where: "WHERE sk.status = 'active' AND COALESCE(sk.gst, 0) = 0",
    select: `sk.sku_code AS ref, ${PO_SKU_NAME} AS label, COALESCE(sk.brand, '') AS sub,
      CONCAT('GST ', COALESCE(sk.gst, 'blank')) AS detail`,
  },
  sku_no_supply_name: {
    scope: "sku", from: "FROM master_skus sk", order: "sk.sku_code",
    where: "WHERE sk.status = 'active' AND TRIM(COALESCE(sk.supply_name, '')) = ''",
    select: "sk.sku_code AS ref, sk.name AS label, COALESCE(sk.brand, '') AS sub, 'Uniware name used on POs' AS detail",
  },
  map_not_in_uniware: {
    scope: "map", order: "m.code, dwe.facility_code, sk.sku_code",
    from: `FROM un_code_mfg_sku_wh_map map
      INNER JOIN master_mfgs m ON m.id = map.mfg_id
      INNER JOIN master_skus sk ON sk.id = map.sku_id
      INNER JOIN details_warehouse_entity dwe ON dwe.id = map.wh_id AND dwe.status = 'active'`,
    where: `WHERE map.status = 'active' AND map.sku_id IS NOT NULL
      AND (map.un_push_error IS NOT NULL OR (map.un_pushed_at IS NULL AND map.un_seen_at IS NULL))`,
    select: `sk.sku_code AS ref, CONCAT(m.code, ' · ', sk.sku_code) AS label, dwe.facility_code AS sub,
      COALESCE(LEFT(map.un_push_error, 160), 'never pushed or seen') AS detail`,
  },
  inv_never_synced: {
    scope: "invoice", order: "si.created_at DESC, si.id DESC",
    from: "FROM invoice_mfg si INNER JOIN master_mfgs m ON m.id = si.mfg_id",
    where: "WHERE si.reverted_at IS NULL AND si.uniware_synced_at IS NULL",
    select: `si.invoice_no AS ref, CONCAT(m.code, ' · ', si.invoice_no) AS label,
      DATE_FORMAT(CONVERT_TZ(si.created_at, '+00:00', '+05:30'), '%Y-%m-%d') AS sub,
      COALESCE(si.destination, '') AS detail`,
  },
}

// Each check is scoped the way its source screen is. Params come from buildDqParams.
const DQ_SCOPE_SQL: Record<DqScope, string> = {
  po: SCOPE_WHERE,
  sku: "AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))",
  map: "AND (? IS NULL OR map.mfg_id IN (?)) AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))",
  invoice: `AND (? IS NULL OR si.mfg_id IN (?)) AND (? IS NULL OR si.destination IN (?)) ${INVOICE_BRAND_SCOPE}`,
}

export function buildDqParams(id: DqCheckId, scope: UserScope): unknown[] {
  const mfg = scopeParams(scope.mfgIds), wh = scopeParams(scope.warehouseNames), brand = scopeParams(scope.brandIds)
  switch (DQ_DEFS[id].scope) {
    case "po": return [...mfg, ...wh, ...brand]
    case "sku": return brand
    case "map": return [...mfg, ...brand]
    case "invoice": return [...mfg, ...wh, ...brand]
  }
}

export const dqSql = Object.fromEntries(DQ_CHECK_IDS.map((id) => {
  const d = DQ_DEFS[id]
  const body = `${d.from} ${d.where} ${DQ_SCOPE_SQL[d.scope]}`
  return [id, {
    /** Params: buildDqParams(id). */
    count: `SELECT COUNT(*) AS total ${body}`,
    /** Params: [...buildDqParams(id), limit]. */
    rows: `SELECT ${d.select} ${body} ORDER BY ${d.order} LIMIT ?`,
  }]
})) as Record<DqCheckId, { count: string; rows: string }>

export const reportsSql = {
  /**
   * Inputs for threeWayMatch() per live invoice, mirroring supplierInvoicesSql.selectMatchFields.
   * Params: [...buildInvoiceParams, limit].
   */
  invoiceMatchRows: `
    SELECT si.id, si.invoice_no, si.invoice_date, si.created_at, si.destination, si.invoice_total,
           si.uniware_status, si.uniware_synced_at,
           m.code AS mfg_code, m.name AS mfg_name,
           COUNT(sii.id)             AS item_count,
           COALESCE(SUM(sii.qty), 0) AS billed_qty,
           COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent, 0) / 100)), 0) AS lines_value,
           COALESCE(SUM(sii.id IS NOT NULL AND sii.received_against_po_id IS NULL), 0) AS po_unlinked_lines,
           (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
           (SELECT COALESCE(SUM(i.quantity - i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_accepted,
           (SELECT COALESCE(SUM(i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_rejected,
           (SELECT COALESCE(SUM(i.rejected_qty * p.unit_price), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id
              JOIN purchase_orders p ON p.id = i.po_id WHERE g.invoice_id = si.id) AS grn_rejected_value,
           (SELECT COUNT(DISTINCT p.id) FROM invoice_items_mfg x
              JOIN purchase_orders p ON p.id = x.received_against_po_id
             WHERE x.invoice_id = si.id) AS po_count,
           (SELECT GROUP_CONCAT(v.leg ORDER BY v.leg) FROM invoice_leg_verification v
             WHERE v.invoice_id = si.id) AS verified_legs,
           (SELECT p.status FROM invoice_payment p WHERE p.invoice_id = si.id) AS payment_status
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
    ${INVOICE_FILTERS}
    ${INVOICE_BRAND_SCOPE}
    GROUP BY si.id
    ORDER BY si.created_at DESC, si.id DESC
    LIMIT ?
  `,

  /** INV-02 lines settled against a priced PO. Params: [...buildInvoiceParams, minAbsPct, minAbsPct, limit, offset]. */
  rateLineRows: `
    SELECT ii.id, si.id AS invoice_id, si.invoice_no, si.invoice_date, si.created_at,
           m.code AS mfg_code, m.name AS mfg_name,
           ii.sku_code, ${PO_SKU_NAME} AS sku_name,
           ii.qty, ii.rate AS invoice_rate,
           po.po_no, po.unit_price AS po_rate,
           ${RATE_DIFF_PCT}           AS diff_pct,
           ${RATE_DIFF} * ii.qty      AS value_at_risk
    FROM invoice_items_mfg ii
    INNER JOIN invoice_mfg si     ON si.id = ii.invoice_id
    INNER JOIN master_mfgs m      ON m.id  = si.mfg_id
    INNER JOIN purchase_orders po ON po.id = ii.received_against_po_id
    LEFT  JOIN master_skus sk     ON sk.sku_code = ii.sku_code
    ${RATE_LINE_WHERE}
      AND (? IS NULL OR ABS(${RATE_DIFF_PCT}) >= ?)
    ORDER BY ABS(${RATE_DIFF} * ii.qty) DESC, ii.id DESC
    LIMIT ? OFFSET ?
  `,

  /** INV-02 totals over the whole filter. Params: [...buildInvoiceParams, minAbsPct, minAbsPct]. */
  rateLineTotals: `
    SELECT COUNT(*)                                            AS total,
           COALESCE(SUM(${RATE_DIFF} > 0), 0)                  AS over_lines,
           COALESCE(SUM(${RATE_DIFF} < 0), 0)                  AS under_lines,
           COALESCE(SUM(GREATEST(${RATE_DIFF}, 0) * ii.qty), 0) AS over_value,
           COALESCE(SUM(LEAST(${RATE_DIFF}, 0) * ii.qty), 0)    AS under_value
    FROM invoice_items_mfg ii
    INNER JOIN invoice_mfg si     ON si.id = ii.invoice_id
    INNER JOIN master_mfgs m      ON m.id  = si.mfg_id
    INNER JOIN purchase_orders po ON po.id = ii.received_against_po_id
    LEFT  JOIN master_skus sk     ON sk.sku_code = ii.sku_code
    ${RATE_LINE_WHERE}
      AND (? IS NULL OR ABS(${RATE_DIFF_PCT}) >= ?)
  `,

  /** Lines INV-02 cannot price: no PO settled, the PO id points at nothing, or the PO is unpriced/special. Params: buildInvoiceParams. */
  rateLineExcluded: `
    SELECT COALESCE(SUM(ii.received_against_po_id IS NULL), 0) AS no_po,
           COALESCE(SUM(ii.received_against_po_id IS NOT NULL AND po.id IS NULL), 0) AS po_missing,
           COALESCE(SUM(po.id IS NOT NULL AND (${PRICE_CLASS_SQL}) <> 'priced'), 0) AS po_unpriced
    FROM invoice_items_mfg ii
    INNER JOIN invoice_mfg si     ON si.id = ii.invoice_id
    INNER JOIN master_mfgs m      ON m.id  = si.mfg_id
    LEFT  JOIN purchase_orders po ON po.id = ii.received_against_po_id
    LEFT  JOIN master_skus sk     ON sk.sku_code = ii.sku_code
    ${INVOICE_FILTERS}
      AND (? IS NULL OR sk.brand_id IS NULL OR sk.brand_id IN (?))
  `,

  /** One row per ordered master (sent to the mfg: not draft/cancelled/reverted). Params: buildFillRateParams. */
  fillRatePos: `
    SELECT
      m.code AS mfg_code, m.name AS mfg_name,
      DATE_FORMAT(po.date, '%Y-%m')      AS month,
      po.qty,
      ${RECEIVED_TOTAL_EXPR}              AS received_qty,
      (${DISPLAY_STATUS_EXPR})            AS display_status,
      po.expected_on,
      ${FIRST_RECEIPT_ON}                 AS first_receipt_on,
      DATEDIFF(${FIRST_RECEIPT_ON}, po.date) AS lead_days
    FROM purchase_orders po
    INNER JOIN master_mfgs m  ON m.id        = po.mfg_id
    LEFT  JOIN master_skus sk ON sk.sku_code = po.sku_code
    ${CHILD_AGG_JOIN}
    ${FIRST_RECEIPT_JOIN}
    WHERE COALESCE(po.po_type, '') <> 'inward'
      ${MASTERS_ONLY}
      ${APPROVED_ONLY}
      AND (${DISPLAY_STATUS_EXPR}) NOT IN ('draft', 'cancelled', 'reverted')
      AND po.date >= ? AND po.date <= ?
      AND (? IS NULL OR m.code     = ?)
      AND (? IS NULL OR po.po_type = ?)
      ${SCOPE_WHERE}
  `,

  /** When invoice-booked receipts begin, so the page can say how far back lead time reaches. */
  firstLiveInvoiceAt: `SELECT MIN(created_at) AS first_at FROM invoice_mfg WHERE reverted_at IS NULL`,

  /** Params: [...buildOpenPoParams, limit, offset]. `sortKey` must come from OPEN_PO_SORTS. */
  openPoRows(sortKey: string, dir: "asc" | "desc") {
    const d = dir === "desc" ? "DESC" : "ASC"
    const order = (OPEN_PO_SORTS[sortKey] ?? OPEN_PO_SORTS.expected_on)
      .map(([expr, follows]) => `${expr} ${follows ? d : "ASC"}`).join(", ")
    return `
      SELECT
        po.id, po.po_no, po.po_type, po.date, po.expected_on, po.destination, po.sku_code,
        ${PO_SKU_NAME}                AS sku_name,
        br.name                       AS brand_name,
        m.code AS mfg_code, m.name    AS mfg_name,
        po.qty,
        ${RECEIVED_TOTAL_EXPR}        AS received_qty,
        ${OPEN_QTY}                   AS open_qty,
        po.unit_price,
        sk.gst                        AS gst_pct,
        ${OPEN_PRE_GST}               AS open_value_pre_gst,
        ${OPEN_INCL_GST}              AS open_value_incl_gst,
        (${PRICE_CLASS_SQL})          AS price_class,
        (${DISPLAY_STATUS_EXPR})      AS display_status,
        COALESCE(ch.child_count, 0)   AS child_count
      ${OPEN_PO_FROM}
      ${OPEN_PO_WHERE}
      ORDER BY ${order}, po.id ${d}
      LIMIT ? OFFSET ?
    `
  },

  /** Totals over the whole filter, not the page. Params: [today, ...buildOpenPoParams]. */
  openPoTotals: `
    SELECT
      COUNT(*)                                                   AS total,
      COALESCE(SUM(${OPEN_QTY}), 0)                              AS open_qty,
      COALESCE(SUM(${OPEN_PRE_GST}), 0)                          AS open_value_pre_gst,
      COALESCE(SUM(${OPEN_INCL_GST}), 0)                         AS open_value_incl_gst,
      COALESCE(SUM(po.expected_on IS NOT NULL AND po.expected_on < ?), 0) AS overdue_pos,
      COALESCE(SUM((${PRICE_CLASS_SQL}) = 'unpriced'), 0)        AS unpriced_pos,
      COALESCE(SUM((${PRICE_CLASS_SQL}) = 'special'), 0)         AS special_pos
    ${OPEN_PO_FROM}
    ${OPEN_PO_WHERE}
  `,
}
