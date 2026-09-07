// Domain counts for /observability > Business.
//
// Only aggregates with no business logic to duplicate live here. PO status
// counts deliberately do NOT: they reuse purchaseOrdersSql.statusCounts, which
// owns DISPLAY_STATUS_EXPR — a second copy of that CASE is how the tabs, badges
// and this page would start disagreeing about what "draft" means.

export const businessSql = {
  /** Pending approvals per module, oldest first. No parameters. */
  approvalsPending: `
    SELECT module,
           COUNT(*)                                   AS pending,
           MIN(raised_on)                             AS oldest_at,
           TIMESTAMPDIFF(HOUR, MIN(raised_on), NOW()) AS oldest_hours
    FROM approvals
    WHERE status = 'pending'
    GROUP BY module
    ORDER BY oldest_at
  `,

  /** Approval throughput over the last N days. Params: [days] */
  approvalsThroughput: `
    SELECT status, COUNT(*) AS cnt
    FROM approvals
    WHERE raised_on >= NOW() - INTERVAL ? DAY
    GROUP BY status
  `,

  /**
   * Invoices inwarded per ISO week. Grouped on invoice_date (the supplier's own
   * date, which is what the desk reconciles against), not created_on.
   * Params: [days]
   */
  invoicesByWeek: `
    SELECT YEARWEEK(invoice_date, 3) AS yearweek,
           MIN(invoice_date)         AS week_start,
           COUNT(*)                  AS invoices,
           COUNT(DISTINCT mfg_id)    AS mfgs
    FROM invoice_mfg
    WHERE invoice_date >= CURDATE() - INTERVAL ? DAY
    GROUP BY yearweek
    ORDER BY yearweek
  `,
}
