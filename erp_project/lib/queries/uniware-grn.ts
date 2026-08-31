/**
 * grn_uniware + grn_items_uniware — the read-only mirror of Unicommerce's inflow
 * receipts. See prisma/add_uniware_grn.sql for why these tables exist.
 *
 * ── NOTHING HERE WRITES TO purchase_orders ───────────────────────────────────
 * received_qty is our record of what the invoice claimed; these tables are the
 * warehouse's record of what it accepted. The two disagreeing is the reportable
 * fact, so a "reconciling" UPDATE would destroy the feature. If you find
 * yourself adding one, read the header of prisma/add_uniware_grn.sql first.
 */

export const uniwareGrn = {
  /**
   * Which mirrored invoices are worth walking.
   *
   * Only those Uniware says have receipts — inflowReceiptsCount is stored by the
   * status sync at no extra API cost, and GRNs are 1+N calls per PO, so this
   * filter is what keeps the sweep inside maxDuration.
   *
   * `uniware_grn_count IS NULL` is included deliberately: NULL means the status
   * sync has never asked, not "no receipts", so those still need a look.
   *
   * Newest first and LIMITed, matching selectAllForStatusSync — the recent ones
   * are the ones still moving, and the caller reports what the limit cut off.
   * Parameters: [limit]
   */
  selectForGrnSync: `
    SELECT si.id, si.uniware_po_code, si.destination, si.buyer_gstin,
           si.uniware_grn_count
    FROM invoice_mfg si
    WHERE si.uniware_po_code IS NOT NULL
      AND (si.uniware_grn_count IS NULL OR si.uniware_grn_count > 0)
    ORDER BY si.id DESC
    LIMIT ?
  `,

  /** Stamp the receipt count the status sync just read. Parameters: [count, invoice_id] */
  setGrnCount: `UPDATE invoice_mfg SET uniware_grn_count = ? WHERE id = ?`,

  /**
   * Mirror one Uniware PO line's pending / QC-pass onto OUR inward PO for that
   * SKU. Matched on (uniware_po_code, sku_code), which is 1:1 only because
   * mergeInwardLinesBySku raises one inward PO per SKU.
   *
   * Writes ONLY the un_* columns and the timestamp. It must never touch
   * received_qty: that is what the invoice claimed at inward time, these are
   * what Uniware says, and the two disagreeing is the reportable fact.
   *
   * Restricted to po_type = 'inward' for the same reason
   * selectInwardPosByUniwareCode is — a Uniware code is stamped on the inward
   * rows an invoice raised, and only those.
   *
   * Parameters: [pending_qty, qc_pass_qty, uniware_po_code, sku_code]
   */
  setUniwareLineQty: `
    UPDATE purchase_orders
       SET un_pending_qty = ?, un_qc_pass_qty = ?, un_line_synced_at = NOW()
     WHERE uniware_po_code = ? AND sku_code = ? AND po_type = 'inward'
  `,

  /**
   * Upsert one receipt header by its Uniware code.
   *
   * ON DUPLICATE KEY rather than delete-then-insert: a receipt can be re-read on
   * every sweep, and re-inserting would burn through auto-increment ids and
   * break the items' FK mid-sweep.
   *
   * Parameters: [grn_code, uniware_po_code, invoice_id, facility_code,
   *              status_code, vendor_invoice_no, grn_created_at,
   *              total_qty, total_rejected_qty, raw]
   */
  upsertGrn: `
    INSERT INTO grn_uniware
      (grn_code, uniware_po_code, invoice_id, facility_code, status_code,
       vendor_invoice_no, grn_created_at, total_qty, total_rejected_qty, synced_at, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    ON DUPLICATE KEY UPDATE
      uniware_po_code    = VALUES(uniware_po_code),
      invoice_id         = VALUES(invoice_id),
      facility_code      = VALUES(facility_code),
      status_code        = VALUES(status_code),
      vendor_invoice_no  = VALUES(vendor_invoice_no),
      grn_created_at     = VALUES(grn_created_at),
      total_qty          = VALUES(total_qty),
      total_rejected_qty = VALUES(total_rejected_qty),
      synced_at          = NOW(),
      raw                = VALUES(raw),
      id                 = LAST_INSERT_ID(id)
  `,

  /**
   * Clear a receipt's lines before re-inserting them.
   *
   * Replace, not upsert-per-line: a receipt can be amended in Uniware and lose a
   * line, and line_no is positional — an upsert would leave the removed line
   * behind as a phantom that still counts toward the totals.
   * Parameters: [grn_id]
   */
  deleteGrnItems: `DELETE FROM grn_items_uniware WHERE grn_id = ?`,

  /**
   * One receipt line.
   *
   * `po_id` is resolved by the caller against (uniware_po_code, sku_code) — it is
   * 1:1 only because mergeInwardLinesBySku raises one inward PO per SKU. NULL is
   * a real state: the warehouse received a SKU we never raised.
   * Parameters: [grn_id, line_no, sku_code, po_id, quantity, rejected_qty,
   *              batch_code, expiry, mfg_date]
   */
  insertGrnItem: `
    INSERT INTO grn_items_uniware
      (grn_id, line_no, sku_code, po_id, quantity, rejected_qty, batch_code, expiry, mfg_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,

  /**
   * Our inward POs for one Uniware PO code, keyed by SKU — the lookup that
   * resolves a receipt line to a PO of ours.
   *
   * Restricted to po_type = 'inward': a Uniware code is stamped on the inward
   * rows an invoice raised, and only those. Parameters: [uniware_po_code]
   */
  selectInwardPosByUniwareCode: `
    SELECT id, sku_code
    FROM purchase_orders
    WHERE uniware_po_code = ? AND po_type = 'inward' AND sku_code IS NOT NULL
  `,

  /**
   * Every GRN line touching one of our POs, for the inwarding panel.
   *
   * Ordered newest receipt first, matching the panel's invoice list. The header
   * fields repeat per line; the client groups by grn_code rather than this
   * making two round trips for a handful of rows.
   * Parameters: [po_id]
   */
  selectByPoId: `
    SELECT g.grn_code, g.status_code, g.vendor_invoice_no, g.grn_created_at,
           g.facility_code,
           i.line_no, i.sku_code, i.quantity, i.rejected_qty,
           i.batch_code, i.expiry, i.mfg_date
    FROM grn_items_uniware i
    INNER JOIN grn_uniware g ON g.id = i.grn_id
    WHERE i.po_id = ?
    ORDER BY g.grn_created_at DESC, g.id DESC, i.line_no ASC
  `,

  /**
   * Accepted / rejected roll-up for one PO.
   *
   * COUNT(DISTINCT g.id), not COUNT(*): one receipt usually carries several
   * lines for the same PO, so counting rows reports "3 GRNs" for one receipt.
   * Mirrors grnTotalsByPo in lib/uniware/grn-totals.ts — keep the two in step.
   * Parameters: [po_id]
   */
  totalsByPo: `
    SELECT COALESCE(SUM(i.quantity), 0)     AS accepted,
           COALESCE(SUM(i.rejected_qty), 0) AS rejected,
           COUNT(DISTINCT i.grn_id)         AS grn_count,
           MAX(g.grn_created_at)            AS last_received_at
    FROM grn_items_uniware i
    INNER JOIN grn_uniware g ON g.id = i.grn_id
    WHERE i.po_id = ?
  `,
}
