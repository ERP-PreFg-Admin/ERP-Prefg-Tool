/**
 * Day-scoped counts for the ops digest — lib/reports/daily-digest.ts.
 *
 * Every query takes a UTC [from, to) from istDayWindowUtc: these columns are UTC
 * DATETIMEs. purchase_orders.date is already IST, so PO counts reuse
 * purchaseOrdersSql.statusCounts instead of appearing here.
 *
 * Counts only, no identifiers — the digest is mailed to people with no
 * /observability grant.
 */

export const digestSql = {
  /** POs whose first notification went out in the window. Params: [from, to] */
  posMailed: `
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE email_sent_at >= ? AND email_sent_at < ?
  `,

  /** Approvals raised in the window, per module. Params: [from, to] */
  approvalsRaised: `
    SELECT module, COUNT(*) AS cnt
    FROM approvals
    WHERE raised_on >= ? AND raised_on < ?
    GROUP BY module
    ORDER BY cnt DESC
  `,

  /** Approvals decided in the window. approved_on stamps both outcomes, so the
   *  status column is what separates them. Params: [from, to] */
  approvalsDecided: `
    SELECT module, status, COUNT(*) AS cnt
    FROM approvals
    WHERE approved_on >= ? AND approved_on < ?
    GROUP BY module, status
    ORDER BY cnt DESC
  `,

  /** Supplier invoices inwarded in the window, by their Uniware push state.
   *  COALESCE because uniware_status is NULL until the push is attempted.
   *  Params: [from, to] */
  invoicesInwarded: `
    SELECT COALESCE(uniware_status, 'not_pushed') AS uniware_status,
           COUNT(*)                               AS cnt
    FROM invoice_mfg
    WHERE created_at >= ? AND created_at < ?
    GROUP BY uniware_status
    ORDER BY cnt DESC
  `,
}

// Removed 2026-09-28: opsByRoute / failuresByRoute. Route names and HTTP
// statuses were the wrong register for this audience; they stay on
// /observability > Requests. Nothing here reads activity_log now.
