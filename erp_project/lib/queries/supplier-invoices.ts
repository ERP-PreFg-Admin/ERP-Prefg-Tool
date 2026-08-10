// Supplier invoice header + line items — the record of what a PO Inwarding
// invoice actually said, and which POs each of its lines resolved to.
//
// See prisma/add_supplier_invoices.sql for the tables.

import { scopeParams, type UserScope } from "@/lib/scope"

// Search + per-user entity scope, shared by listInvoices and countInvoices so
// the pager total can never disagree with the rows. Mirrors SCOPE_WHERE in
// lib/queries/purchase-orders.ts: warehouse compares against `destination`,
// which holds a master_warehouse.name (there is no FK) — lib/scope.ts resolves
// ids to names for exactly this reason.
// Params: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames)]
const INVOICE_WHERE = `
  WHERE (? IS NULL OR si.invoice_no LIKE ? OR m.name LIKE ?)
    AND (? IS NULL OR si.mfg_id      IN (?))
    AND (? IS NULL OR si.destination IN (?))
`

// The list itself, shared by the paginated view and the export so the two can
// never disagree about which invoices match. Only the LIMIT differs.
const INVOICE_LIST_BODY = `
  SELECT si.id, si.invoice_no, si.invoice_date, si.currency, si.destination,
         si.invoice_total, si.eway_bill_no, si.vehicle_no,
         si.attachment_key, si.created_at,
         m.code AS mfg_code, m.name AS mfg_name,
         u.name AS created_by_name,
         COUNT(sii.id)                   AS item_count,
         SUM(sii.link_type = 'received') AS received_count
  FROM invoice_mfg si
  INNER JOIN master_mfgs m ON m.id = si.mfg_id
  LEFT JOIN users u ON u.id = si.created_by
  LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
  ${INVOICE_WHERE}
  GROUP BY si.id
  ORDER BY si.created_at DESC, si.id DESC
`

export const supplierInvoicesSql = {
  /**
   * Insert the invoice header. Violating uq_supplier_invoice (mfg_id, invoice_no)
   * raises ER_DUP_ENTRY — that is the duplicate-submission guard, and it has to
   * stay a constraint rather than a pre-check so two concurrent submits can't
   * both pass.
   *
   * Parameters: [mfg_id, invoice_no, invoice_date, currency, eway_bill_no,
   *   vehicle_no, po_ref, seller_gstin, buyer_gstin, bill_to_name,
   *   bill_to_address, bill_to_state, ship_to_name, ship_to_address,
   *   destination, invoice_total, attachment_key, created_by]
   */
  insertHeader: `
    INSERT INTO invoice_mfg
      (mfg_id, invoice_no, invoice_date, currency, eway_bill_no, vehicle_no,
       po_ref, seller_gstin, buyer_gstin, bill_to_name, bill_to_address,
       bill_to_state, ship_to_name, ship_to_address, destination,
       invoice_total, attachment_key, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Insert one invoice line. po_id is the inward PO the line raised;
   * received_against_po_id is the pre-existing PO it was also booked against,
   * or NULL for a plain inward line.
   * Parameters: [invoice_id, line_no, po_id, received_against_po_id, link_type,
   *   sku_code, parsed_sku_code, sku_name, batch, mfg_date, expiry, hsn, qty,
   *   rate, mrp, discount, gst_percent, amount, total_amount]
   */
  insertItem: `
    INSERT INTO invoice_items_mfg
      (invoice_id, line_no, po_id, received_against_po_id, link_type, sku_code,
       parsed_sku_code, sku_name, batch, mfg_date, expiry, hsn, qty, rate, mrp,
       discount, gst_percent, amount, total_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Store the code Uniware assigned. Runs after the mirror succeeds but still
   * inside the same transaction, so an invoice never commits claiming a Uniware
   * PO that doesn't exist. Parameters: [uniware_po_code, invoice_id]
   */
  setUniwarePoCode: `UPDATE invoice_mfg SET uniware_po_code = ? WHERE id = ?`,

  /**
   * Has this manufacturer already had this invoice entered? Drives the
   * dialog's pre-flight warning at review time — the constraint above is what
   * actually enforces it. Parameters: [mfg_id, invoice_no]
   */
  findByMfgAndNo: `
    SELECT si.id, si.invoice_no, si.created_at, u.name AS created_by_name
    FROM invoice_mfg si
    LEFT JOIN users u ON u.id = si.created_by
    WHERE si.mfg_id = ? AND si.invoice_no = ?
    LIMIT 1
  `,

  /** PO numbers already recorded against an invoice, for the duplicate message.
   *  Parameters: [invoice_id] */
  poNosForInvoice: `
    SELECT po.po_no
    FROM invoice_items_mfg sii
    INNER JOIN purchase_orders po ON po.id = sii.po_id
    WHERE sii.invoice_id = ?
    ORDER BY sii.line_no
  `,

  /** Invoice lines inwarded against one PO — "which invoice brought this in?".
   *  Matches either link, so it answers both for an inward PO and for the
   *  pre-existing order it fulfilled. Backs the FG PO Tracking inwarding panel.
   *
   *  mfg_code/mfg_name are deliberately absent: they belong to the order, not
   *  the line, and would repeat identically on every row. The panel takes them
   *  from the order row instead (see selectInwardingHeader).
   *
   *  Parameters: [po_id, po_id] */
  selectByPoId: `
    SELECT si.id            AS invoice_id,
           si.invoice_no,
           si.invoice_date,
           si.invoice_total,
           si.attachment_key,
           si.uniware_po_code,
           si.created_at,
           u.name           AS created_by_name,
           sii.line_no,
           sii.link_type,
           sii.sku_code,
           sii.sku_name,
           sii.batch,
           sii.expiry,
           sii.rate,
           sii.qty          AS line_qty,
           sii.total_amount AS line_total
    FROM invoice_items_mfg sii
    INNER JOIN invoice_mfg si ON si.id = sii.invoice_id
    LEFT  JOIN users u ON u.id = si.created_by
    WHERE sii.po_id = ? OR sii.received_against_po_id = ?
    ORDER BY si.invoice_date DESC, si.id DESC, sii.line_no
  `,

  /** Order header for the inwarding panel — the reconciliation numbers come
   *  from the order itself, not from whatever the table happened to load, so
   *  the panel renders for a PO that isn't on the current page.
   *  Parameters: [po_id] */
  selectInwardingHeader: `
    SELECT po.id, po.po_no, po.status, po.qty, po.received_qty,
           m.code AS mfg_code, m.name AS mfg_name
    FROM purchase_orders po
    INNER JOIN master_mfgs m ON m.id = po.mfg_id
    WHERE po.id = ?
  `,

  /**
   * Invoice history list, newest first.
   *
   * Parameters: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames), limit, offset]
   * — i.e. 3 + 2 + 2 + 2 = 9 values. countInvoices takes the same first 7.
   */
  listInvoices: `
    ${INVOICE_LIST_BODY}
    LIMIT ? OFFSET ?
  `,

  /**
   * Same list, unpaginated — the export must return every invoice the filtered
   * view would page through, not just the page on screen.
   * Parameters: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames)] (7)
   */
  listInvoicesForExport: INVOICE_LIST_BODY,

  /**
   * Every line of every invoice the same filter matches, flattened with its
   * invoice header — the sheet finance actually reconciles against. Both PO
   * numbers ride along: the inward PO the line raised, and the order it
   * settled.
   * Parameters: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames)] (7)
   */
  listInvoiceItemsForExport: `
    SELECT si.invoice_no, si.invoice_date, si.destination,
           m.code AS mfg_code, m.name AS mfg_name,
           sii.line_no, sii.sku_code, sii.parsed_sku_code, sii.sku_name,
           sii.batch, sii.mfg_date, sii.expiry, sii.hsn,
           sii.qty, sii.rate, sii.gst_percent, sii.amount, sii.total_amount,
           sii.link_type,
           inw.po_no AS inward_po_no,
           ref.po_no AS received_against_po_no
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    INNER JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
    LEFT JOIN purchase_orders inw ON inw.id = sii.po_id
    LEFT JOIN purchase_orders ref ON ref.id = sii.received_against_po_id
    ${INVOICE_WHERE}
    ORDER BY si.created_at DESC, si.id DESC, sii.line_no
  `,

  /**
   * Total invoices, for the pager. Must carry the SAME predicates as
   * listInvoices or the total counts rows the list can't show.
   * Parameters: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames)] (7)
   */
  countInvoices: `
    SELECT COUNT(*) AS total
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    ${INVOICE_WHERE}
  `,

  /** Header for one invoice. Parameters: [id] */
  selectInvoiceById: `
    SELECT si.*, m.code AS mfg_code, m.name AS mfg_name, u.name AS created_by_name
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    LEFT JOIN users u ON u.id = si.created_by
    WHERE si.id = ?
  `,

  /**
   * Lines for one invoice, with both PO numbers resolved — the inward PO the
   * line raised, and the order it was received against. Parameters: [id]
   */
  selectItemsByInvoiceId: `
    SELECT sii.*,
           inw.po_no    AS po_no,
           inw.status   AS po_status,
           ref.po_no    AS received_against_po_no,
           ref.qty      AS received_against_qty,
           ref.received_qty AS received_against_received_qty
    FROM invoice_items_mfg sii
    LEFT JOIN purchase_orders inw ON inw.id = sii.po_id
    LEFT JOIN purchase_orders ref ON ref.id = sii.received_against_po_id
    WHERE sii.invoice_id = ?
    ORDER BY sii.line_no
  `,
}

/**
 * Params for INVOICE_WHERE — the 7 values both listInvoices and countInvoices
 * take before their own trailing args (listInvoices then wants limit, offset).
 * Same shape as buildFilterParams in lib/queries/purchase-orders.ts.
 */
export function buildInvoiceParams(search: string | null, scope: UserScope): unknown[] {
  const like = search ? `%${search}%` : null
  return [
    like, like, like,                    // search ×3 (IS NULL check + two LIKEs)
    ...scopeParams(scope.mfgIds),        // ×2
    ...scopeParams(scope.warehouseNames) // ×2
  ]
}
