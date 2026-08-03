// Supplier invoice header + line items — the record of what a PO Inwarding
// invoice actually said, and which POs each of its lines resolved to.
//
// See prisma/add_supplier_invoices.sql for the tables.

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
    INSERT INTO supplier_invoices
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
    INSERT INTO supplier_invoice_items
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
  setUniwarePoCode: `UPDATE supplier_invoices SET uniware_po_code = ? WHERE id = ?`,

  /**
   * Has this manufacturer already had this invoice entered? Drives the
   * dialog's pre-flight warning at review time — the constraint above is what
   * actually enforces it. Parameters: [mfg_id, invoice_no]
   */
  findByMfgAndNo: `
    SELECT si.id, si.invoice_no, si.created_at, u.name AS created_by_name
    FROM supplier_invoices si
    LEFT JOIN users u ON u.id = si.created_by
    WHERE si.mfg_id = ? AND si.invoice_no = ?
    LIMIT 1
  `,

  /** PO numbers already recorded against an invoice, for the duplicate message.
   *  Parameters: [invoice_id] */
  poNosForInvoice: `
    SELECT po.po_no
    FROM supplier_invoice_items sii
    INNER JOIN purchase_orders po ON po.id = sii.po_id
    WHERE sii.invoice_id = ?
    ORDER BY sii.line_no
  `,

  /** Full invoice header + lines for one PO — "which invoice brought this in?".
   *  Matches either link, so it answers for the inward PO and for the order it
   *  fulfilled. Parameters: [po_id, po_id] */
  selectByPoId: `
    SELECT si.*, sii.line_no, sii.link_type, sii.sku_code, sii.batch,
           sii.qty AS line_qty, sii.total_amount AS line_total
    FROM supplier_invoice_items sii
    INNER JOIN supplier_invoices si ON si.id = sii.invoice_id
    WHERE sii.po_id = ? OR sii.received_against_po_id = ?
    ORDER BY sii.line_no
  `,

  /** Invoice history list, newest first. Parameters: [limit, offset] */
  listInvoices: `
    SELECT si.id, si.invoice_no, si.invoice_date, si.currency, si.destination,
           si.invoice_total, si.eway_bill_no, si.vehicle_no,
           si.attachment_key, si.created_at,
           m.code AS mfg_code, m.name AS mfg_name,
           u.name AS created_by_name,
           COUNT(sii.id)                                            AS item_count,
           SUM(sii.link_type = 'received')                          AS received_count
    FROM supplier_invoices si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    LEFT JOIN users u ON u.id = si.created_by
    LEFT JOIN supplier_invoice_items sii ON sii.invoice_id = si.id
    GROUP BY si.id
    ORDER BY si.created_at DESC, si.id DESC
    LIMIT ? OFFSET ?
  `,

  /** Total invoices, for the history list's pager. */
  countInvoices: `SELECT COUNT(*) AS total FROM supplier_invoices`,

  /** Header for one invoice. Parameters: [id] */
  selectInvoiceById: `
    SELECT si.*, m.code AS mfg_code, m.name AS mfg_name, u.name AS created_by_name
    FROM supplier_invoices si
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
    FROM supplier_invoice_items sii
    LEFT JOIN purchase_orders inw ON inw.id = sii.po_id
    LEFT JOIN purchase_orders ref ON ref.id = sii.received_against_po_id
    WHERE sii.invoice_id = ?
    ORDER BY sii.line_no
  `,
}
