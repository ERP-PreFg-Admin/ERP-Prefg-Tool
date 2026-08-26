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
// Brand is per LINE, not per invoice: invoice_mfg has no brand column and one
// invoice can legitimately carry several brands' SKUs. So the test is EXISTS —
// "does this invoice contain any line I'm allowed to see" — not an equality join,
// which would both drop multi-brand invoices and multiply rows against the
// GROUP BY that produces item_count / received_count.
//
// An invoice whose lines resolve to no brand (unmapped sku_code, or a SKU with
// brand_id NULL) is visible, consistent with the rule everywhere else. That is
// what the second NOT EXISTS arm does: nothing attributable means nothing to
// exclude on.
//
// Params: [search×3, scopeParams(mfgIds), scopeParams(warehouseNames),
//          scopeParams(brandIds) ×2 — the flag is read twice, once per arm,
//          mfgCode×2, destination×2, dateFrom×2, dateTo×2]
const INVOICE_WHERE = `
  WHERE (? IS NULL OR si.invoice_no LIKE ? OR m.name LIKE ?)
    AND (? IS NULL OR si.mfg_id      IN (?))
    AND (? IS NULL OR si.destination IN (?))
    AND (? IS NULL OR EXISTS (
          SELECT 1 FROM invoice_items_mfg ii
          JOIN master_skus ms ON ms.sku_code = ii.sku_code
          WHERE ii.invoice_id = si.id AND ms.brand_id IN (?)
        )
        OR NOT EXISTS (
          SELECT 1 FROM invoice_items_mfg ii
          JOIN master_skus ms ON ms.sku_code = ii.sku_code
          WHERE ii.invoice_id = si.id AND ms.brand_id IS NOT NULL
        ))
    AND (? IS NULL OR m.code          = ?)
    AND (? IS NULL OR si.destination  = ?)
    AND (? IS NULL OR si.invoice_date >= ?)
    AND (? IS NULL OR si.invoice_date <= ?)
`

// The list itself, shared by the paginated view and the export so the two can
// never disagree about which invoices match. Only the LIMIT differs.
const INVOICE_LIST_BODY = `
  SELECT si.id, si.invoice_no, si.invoice_date, si.currency, si.destination,
         si.invoice_total, si.eway_bill_no, si.vehicle_no,
         si.attachment_key, si.uniware_po_code,
         si.uniware_status, si.uniware_synced_at, si.created_at,
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
   * Every mirrored invoice, for the sync-all button — the code to ask Uniware
   * about, plus the two facts that decide which facility to ask as (destination
   * and the PAN of the entity billed; see warehouse.facilityByDestinationAndPan).
   *
   * One row per Uniware PO, because that is the grain of uniware_po_code here:
   * the inward POs sharing a code are not listed separately, so the sync makes
   * one call per Uniware PO rather than one per PO row.
   *
   * Newest first and LIMITed: the recent ones are the ones still moving, and an
   * unbounded list would be an unbounded number of Uniware round trips inside one
   * request. The caller reports what the limit cut off.
   * Parameters: [limit]
   */
  selectAllForStatusSync: `
    SELECT si.id, si.uniware_po_code, si.destination, si.buyer_gstin
    FROM invoice_mfg si
    WHERE si.uniware_po_code IS NOT NULL
    ORDER BY si.id DESC
    LIMIT ?
  `,

  /** Stamp what Uniware just said, and when it said it.
   *  Parameters: [uniware_status, id] */
  setUniwareStatus: `
    UPDATE invoice_mfg
       SET uniware_status = ?, uniware_synced_at = NOW()
     WHERE id = ?
  `,

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
   * Parameters: buildInvoiceParams(...) (15), then limit, offset.
   */
  listInvoices: `
    ${INVOICE_LIST_BODY}
    LIMIT ? OFFSET ?
  `,

  /**
   * Same list, unpaginated — the export must return every invoice the filtered
   * view would page through, not just the page on screen.
   * Parameters: buildInvoiceParams(...) (15)
   */
  listInvoicesForExport: INVOICE_LIST_BODY,
  /**
   * Highest serial already minted in one ERP PO-code series.
   *
   * Params: ['M/MUM1/2627/%'] — the prefix from poPrefix() plus '/%'.
   *
   * The prefix carries the FY, so this is (facility, FY)-scoped and the series
   * restarts each April by construction rather than by a reset step.
   *
   * SUBSTRING_INDEX(.., '/', -1) takes the segment after the last slash and CAST
   * ... UNSIGNED reads its leading digits; a code with no numeric tail casts to 0
   * and is ignored rather than throwing. LIKE is anchored by the literal prefix,
   * so no other facility's or year's codes are in range.
   *
   * MAX and not COUNT(*): see lib/uniware/po-serial.ts for why counting reissues
   * a used number.
   */

  maxUniwarePoSerial: `
    SELECT MAX(CAST(SUBSTRING_INDEX(uniware_po_code, '/', -1) AS UNSIGNED)) AS max_serial
      FROM invoice_mfg
     WHERE uniware_po_code LIKE ?
  `,
  /**
   * Every line of every invoice the same filter matches, flattened with its
   * invoice header — the sheet finance actually reconciles against. Both PO
   * numbers ride along: the inward PO the line raised, and the order it
   * settled.
   * Parameters: buildInvoiceParams(...) (15)
   */
  listInvoiceItemsForExport: `
     SELECT si.invoice_no, si.invoice_date, si.destination,
           si.invoice_total, si.eway_bill_no, si.vehicle_no,
           u.name AS created_by_name, si.created_at,
           m.code AS mfg_code, m.name AS mfg_name,
           sii.line_no, sii.sku_code, sii.parsed_sku_code, sii.sku_name,
           sii.batch, sii.mfg_date, sii.expiry, sii.hsn,
           sii.qty, sii.rate, sii.gst_percent, sii.amount, sii.total_amount,
           sii.link_type,
           inw.po_no AS inward_po_no,
           ref.po_no AS received_against_po_no
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    LEFT  JOIN users u ON u.id = si.created_by
    LEFT  JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
    LEFT JOIN purchase_orders inw ON inw.id = sii.po_id
    LEFT JOIN purchase_orders ref ON ref.id = sii.received_against_po_id
    ${INVOICE_WHERE}
    ORDER BY si.created_at DESC, si.id DESC, sii.line_no
  `,

  /**
   * Total invoices, for the pager. Must carry the SAME predicates as
   * listInvoices or the total counts rows the list can't show.
   * Parameters: buildInvoiceParams(...) (15)
   */
  countInvoices: `
    SELECT COUNT(*) AS total
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    ${INVOICE_WHERE}
  `,

  /**
   * The scope facts for one invoice — the same dimensions INVOICE_WHERE filters
   * the list on, minus brand (per LINE, see selectInvoiceLineBrandIds below).
   * Used by assertInvoiceInScope; selectInvoiceById returns si.* including
   * GSTINs and bill-to addresses, so it must never run unguarded.
   * Parameters: [id]
   */
  selectInvoiceScopeById: `
    SELECT si.id, si.mfg_id, si.destination
    FROM invoice_mfg si
    WHERE si.id = ?
  `,

  /**
   * The distinct brands this invoice's lines resolve to, unattributed lines
   * excluded — the JS-side equivalent of INVOICE_WHERE's EXISTS/NOT EXISTS pair.
   * Zero rows means nothing attributable, which is visible to everyone, exactly
   * as the NOT EXISTS arm decides. Parameters: [id]
   */
  selectInvoiceLineBrandIds: `
    SELECT DISTINCT ms.brand_id
    FROM invoice_items_mfg ii
    JOIN master_skus ms ON ms.sku_code = ii.sku_code
    WHERE ii.invoice_id = ? AND ms.brand_id IS NOT NULL
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

/** The user-chosen filters on /po-tracking/invoices. All optional — an absent
 *  one is a NULL, which the `? IS NULL OR …` pairs read as "no filter". */
export type InvoiceFilters = {
  /** master_mfgs.code, not the id — same as the PO list's manufacturer filter. */
  mfgCode?: string | null
  /** invoice_mfg.destination holds a master_warehouse.name (no FK). */
  destination?: string | null
  dateFrom?: string | null
  dateTo?: string | null
}

/**
 * Params for INVOICE_WHERE — the 15 values both listInvoices and countInvoices
 * take before their own trailing args (listInvoices then wants limit, offset).
 * Same shape as buildFilterParams in lib/queries/purchase-orders.ts.
 */
export function buildInvoiceParams(
  search: string | null,
  scope: UserScope,
  f: InvoiceFilters = {},
): unknown[] {
  const like = search ? `%${search}%` : null
  const [brandFlag, brandIds] = scopeParams(scope.brandIds)
  return [
    like, like, like,                    // search ×3 (IS NULL check + two LIKEs)
    ...scopeParams(scope.mfgIds),        // ×2
    ...scopeParams(scope.warehouseNames),// ×2
    // Brand is 3 params, not the usual 2: the flag guards the whole
    // EXISTS-or-NOT-EXISTS group, and only the first arm takes the id list. The
    // second arm asks "is anything attributable at all", which needs no ids.
    brandFlag, brandIds,                 // flag + ids for the EXISTS arm
    // Each filter is read twice: once for the IS NULL check, once for the
    // comparison. Empty string is coerced to NULL so a cleared <select> clears
    // the filter instead of matching a manufacturer code of "".
    f.mfgCode     || null, f.mfgCode     || null,
    f.destination || null, f.destination || null,
    f.dateFrom    || null, f.dateFrom    || null,
    f.dateTo      || null, f.dateTo      || null,
  ]
}
