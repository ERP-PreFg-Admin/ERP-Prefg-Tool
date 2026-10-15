// SQL behind reverting an inwarded invoice (lib/invoice/invoice-revert.ts).
// Never a question mark in these comments — mysql2 reads one as a placeholder.

export const invoiceRevertSql = {
  /** The header, locked. The first lock a revert takes. Params: [id] */
  lockInvoice: `
    SELECT id, invoice_no, mfg_id, destination, buyer_gstin, uniware_po_code,
           uniware_grn_count, reverted_at
      FROM invoice_mfg WHERE id = ? FOR UPDATE
  `,

  /** The header, unlocked, plus the manufacturer, for the request route's pre-checks. Params: [id] */
  selectHeader: `
    SELECT si.id, si.invoice_no, si.mfg_id, si.destination, si.buyer_gstin, si.uniware_po_code,
           si.reverted_at, m.name AS mfg_name
      FROM invoice_mfg si
      JOIN master_mfgs m ON m.id = si.mfg_id
     WHERE si.id = ?
  `,

  /** Is the invoice writable: shared lock so a revert can't land between this check and the write. Params: [id] */
  shareInvoiceState: `
    SELECT si.reverted_at,
           EXISTS (SELECT 1 FROM approvals a WHERE a.module = 'INVOICE_REVERT'
                     AND a.entity_id = si.id AND a.status = 'pending') AS revert_pending
      FROM invoice_mfg si WHERE si.id = ? FOR SHARE
  `,

  /** Its lines' SKUs and PO links, unlocked, for the scope checks run before the transaction. Params: [invoice_id] */
  selectLineRefs: `
    SELECT sku_code, po_id, received_against_po_id FROM invoice_items_mfg WHERE invoice_id = ?
  `,

  /** Its lines, locked. Params: [invoice_id] */
  lockLines: `
    SELECT id, line_no, po_id, received_against_po_id, link_type, sku_code, qty
      FROM invoice_items_mfg WHERE invoice_id = ? ORDER BY line_no FOR UPDATE
  `,

  /** Every PO the lines touch, locked in ascending id. query() expands the array. Params: [ids[]] */
  lockPos: `
    SELECT id, po_no, po_type, status, qty, received_qty
      FROM purchase_orders WHERE id IN (?) ORDER BY id FOR UPDATE
  `,

  /** The blockers that live in other tables. Params: [id, id, id, id] */
  blockers: `
    SELECT (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = ?)              AS grn_rows,
           (SELECT COUNT(*) FROM invoice_payment p WHERE p.invoice_id = ?)          AS payment_rows,
           (SELECT COUNT(*) FROM invoice_leg_verification v WHERE v.invoice_id = ?) AS verified_legs,
           (SELECT COALESCE(uniware_grn_count, 0) FROM invoice_mfg WHERE id = ?)    AS uniware_grn_count
  `,

  /** Inward POs another invoice's line, or a GRN line, also points at. Params: [ids[], invoice_id] */
  sharedInward: `
    SELECT DISTINCT po.po_no
      FROM purchase_orders po
     WHERE po.id IN (?)
       AND (EXISTS (SELECT 1 FROM invoice_items_mfg x WHERE x.po_id = po.id AND x.invoice_id <> ?)
            OR EXISTS (SELECT 1 FROM grn_items_uniware gi WHERE gi.po_id = po.id))
  `,

  /** Params: [received_qty, id] */
  setReceived: `UPDATE purchase_orders SET received_qty = ? WHERE id = ?`,

  /** Reopen an auto-closed PO; the status guard keeps a concurrent manual change. Params: [id] */
  reopen: `UPDATE purchase_orders SET status = 'raised' WHERE id = ? AND status = 'received'`,

  /** Mark the inward POs reverted. query() expands the array. Params: [ids[]] */
  revertInward: `
    UPDATE purchase_orders SET status = 'reverted'
     WHERE id IN (?) AND status <> 'reverted'
  `,

  /** Params: [reverted_by, revert_approved_by, revert_approval_id, revert_reason, id] */
  stampInvoice: `
    UPDATE invoice_mfg
       SET reverted_at = NOW(), reverted_by = ?, revert_approved_by = ?,
           revert_approval_id = ?, revert_reason = ?
     WHERE id = ? AND reverted_at IS NULL
  `,

  /** Label on the approvals queue. Params: [entity_id] */
  entityLabel: `
    SELECT si.invoice_no AS code, m.name AS name, NULL AS secondary_code, NULL AS secondary_name
      FROM invoice_mfg si JOIN master_mfgs m ON m.id = si.mfg_id
     WHERE si.id = ? LIMIT 1
  `,
}
