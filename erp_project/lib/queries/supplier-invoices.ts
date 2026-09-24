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
/**
 * Uniware states a purchase order never leaves.
 *
 * Exported because the GRN and document sweeps want the same rule, and two
 * copies would eventually disagree about what "finished" means.
 */
export const TERMINAL_UNIWARE_STATUSES = ["COMPLETE", "CANCELLED"] as const

/** How long a terminal PO stays skipped before it is re-read once anyway. */
export const TERMINAL_RECHECK_DAYS = 30

/**
 * Which mirrored invoices a status sweep should still ASK Uniware about.
 *
 * The sweep used to take every mirrored invoice, so a PO closed months ago was
 * re-fetched on every run — and because every PO eventually reaches COMPLETE,
 * that pile only ever grows. Measured on prod: 11 of 52 invoices were already
 * COMPLETE, and those 11 carried 11 of the 12 expensive `1+N` receipt walks, so
 * most of a run's cost was spent re-confirming answers that were already final.
 *
 * Skipping them makes a run cost a function of OPEN work rather than of
 * history, which is the only reason this stops getting slower as invoices
 * accumulate. It is not permanent: a terminal PO not checked in
 * TERMINAL_RECHECK_DAYS is re-admitted, so one amended after closing is still
 * eventually re-read.
 *
 * `uniware_status IS NULL` is the never-synced case and must always qualify.
 */
const SYNC_CANDIDATE_PREDICATE = `
  si.uniware_po_code IS NOT NULL
    AND (si.uniware_status IS NULL
         OR si.uniware_status NOT IN (${TERMINAL_UNIWARE_STATUSES.map((s) => `'${s}'`).join(", ")})
         OR si.uniware_synced_at IS NULL
         OR si.uniware_synced_at < NOW() - INTERVAL ${TERMINAL_RECHECK_DAYS} DAY)
`

/**
 * Least-recently-checked first, never-synced before everything.
 *
 * Replaces `id DESC`, which meant the run's LIMIT always re-took the same
 * newest rows and older ones were never reached again once the mirrored set
 * passed the cap. `uniware_synced_at IS NOT NULL` sorts 0 for NULL, so ASC puts
 * the never-synced at the front without a NULLS FIRST clause MySQL lacks.
 */
const SYNC_CANDIDATE_ORDER = `
  si.uniware_synced_at IS NOT NULL, si.uniware_synced_at ASC, si.id DESC
`

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
    -- Uniware's own verdict on the mirrored PO. 'none' is the never-synced
    -- case: uniware_status IS NULL covers both "no mirror" and "not asked yet",
    -- which is what the filter's own label says.
    AND (? IS NULL
         OR (? = 'none' AND si.uniware_status IS NULL)
         OR si.uniware_status = ?)
`

// The list itself, shared by the paginated view and the export so the two can
// never disagree about which invoices match. Only the LIMIT differs.
const INVOICE_LIST_BODY = `
  SELECT si.id, si.invoice_no, si.invoice_date, si.currency, si.destination,
         si.invoice_total, si.eway_bill_no, si.vehicle_no,
         si.attachment_key, si.uniware_po_code,
         si.uniware_status, si.uniware_synced_at, si.created_at,
         m.code AS mfg_code, m.name AS mfg_name,
         -- invoice_mfg.destination stores a master_warehouse.name and there is
         -- no FK, so the code is a join on the name. Safe: uq_warehouse_name
         -- makes it 1:1, and a LEFT JOIN keeps an invoice whose destination
         -- predates the warehouse master rather than dropping it.
         w.code AS destination_code,
         e.code AS entity_code, e.legal_name AS entity_name,
         u.name AS created_by_name,
         COUNT(sii.id)                   AS item_count,
         SUM(sii.link_type = 'received') AS received_count,
         -- Total quantity BILLED on this invoice. Safe to aggregate here beside
         -- COUNT(sii.id): both read the same joined item rows at the same grain.
         -- It is the minuend of Short Qty — billed, less whatever the warehouse
         -- accounted for below.
         COALESCE(SUM(sii.qty), 0)       AS billed_qty,
         -- The lines' own value, to check against the header's invoice_total.
         -- Grossed by gst: invoice_total is the payable, amount is taxable.
         COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent, 0) / 100)), 0)
           AS lines_value,
         -- The sii.id test is load-bearing: this is a LEFT JOIN, so an invoice
         -- with no lines yields one all-NULL row, and NULL IS NULL would count
         -- it as an unlinked line.
         COALESCE(SUM(sii.id IS NOT NULL AND sii.received_against_po_id IS NULL), 0)
           AS po_unlinked_lines,
         -- ── What the warehouse actually accepted (grn_uniware) ─────────────
         -- SCALAR SUBQUERIES, not joins. This query already LEFT JOINs
         -- invoice_items_mfg and GROUP BYs si.id, so a second join would
         -- multiply the row set and silently inflate item_count and
         -- received_count above. Same technique, and the same reason, as the
         -- uniware_status subquery in lib/queries/purchase-orders.ts.
         --
         -- All three read 0 for an invoice nobody has synced GRNs for, which is
         -- indistinguishable from "synced, nothing received" — invoice_mfg
         -- .uniware_grn_count is the field that tells those apart.
         --
         -- ── grn_items_uniware.quantity IS GROSS ──────────────────────────
         -- It is what came in the box, rejections included — confirmed on
         -- prod: MPO-INW-202609-023 reads quantity 2496, rejected 1, and
         -- Uniware's own un_qc_pass_qty 2495. So the GOOD, sellable figure is
         -- quantity - rejected_qty, and that is what "accepted" means
         -- everywhere in this file. Summing quantity alone counts the rejected
         -- units as sellable and then adds them again as rejected.
         (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id)
           AS grn_count,
         (SELECT COALESCE(SUM(i.quantity - i.rejected_qty), 0)
            FROM grn_items_uniware i
            JOIN grn_uniware g ON g.id = i.grn_id
           WHERE g.invoice_id = si.id) AS grn_accepted,
         (SELECT COALESCE(SUM(i.rejected_qty), 0)
            FROM grn_items_uniware i
            JOIN grn_uniware g ON g.id = i.grn_id
           WHERE g.invoice_id = si.id) AS grn_rejected,
         -- Rejected VALUE, priced from the inward PO the line resolved to.
         --
         -- Through po_id rather than matching invoice_items_mfg on sku_code: an
         -- invoice can carry the same SKU on two lines at two rates, so a SKU
         -- join is both ambiguous and a fan-out. po_id is one row per receipt
         -- line, so this is 1:1, and purchase_orders.unit_price on an inward PO
         -- IS the invoice's own rate — it was written from it at inward time.
         --
         -- An INNER join deliberately: a receipt line with no po_id is a SKU we
         -- never raised, and pricing it at zero would understate the loss
         -- silently. It contributes nothing here and is findable by its NULL.
         (SELECT COALESCE(SUM(i.rejected_qty * po.unit_price), 0)
            FROM grn_items_uniware i
            JOIN grn_uniware g      ON g.id  = i.grn_id
            JOIN purchase_orders po ON po.id = i.po_id
           WHERE g.invoice_id = si.id) AS grn_rejected_value,
         -- ── The PO leg: whether every line settled a real order ────────────
         -- NB: never a question mark in these comments — mysql2 reads one as a
         -- placeholder even inside a comment, shifting every param after it.
         -- tests/unit/invoice-filters.test.ts is what catches that.
         -- Presence only, no ordered quantity. One PO is settled by up to 20
         -- invoices, so SUM(po.qty) over them is not "ordered for this invoice"
         -- and any comparison against it reads short on nearly every row. The
         -- per-PO figures live on the lines (received_against_qty).
         --
         -- Counted through purchase_orders, not off the column: dev carries
         -- lines pointing at deleted POs, and a dangling id read as "PO on
         -- file" while its ordered quantity summed to 0. COUNT(DISTINCT) skips NULLs, so
         -- an invoice that settled nothing reads 0 — "PO not on file".
         (SELECT COUNT(DISTINCT po.id)
            FROM invoice_items_mfg x
            JOIN purchase_orders po ON po.id = x.received_against_po_id
           WHERE x.invoice_id = si.id) AS po_count,
         -- Which legs a human has physically signed off, as a CSV of leg names.
         -- No row means unverified, so NULL here is the common case and the
         -- correct reading — there is deliberately no verified=0 row to find.
         (SELECT GROUP_CONCAT(v.leg ORDER BY v.leg)
            FROM invoice_leg_verification v
           WHERE v.invoice_id = si.id) AS verified_legs,
         -- The hand-set payment state, NULL when nobody has touched it — which
         -- is what makes the column fall back to the match's own reading.
         (SELECT p.status FROM invoice_payment p WHERE p.invoice_id = si.id)
           AS payment_status,
         (SELECT p.utr FROM invoice_payment p WHERE p.invoice_id = si.id)
           AS payment_utr
  FROM invoice_mfg si
  INNER JOIN master_mfgs m ON m.id = si.mfg_id
  LEFT JOIN master_warehouse w ON w.name = si.destination
  -- PAN, never the full GSTIN — see the line-item query for why.
  LEFT JOIN master_entity e ON e.pan = SUBSTRING(si.buyer_gstin, 3, 10)
  LEFT JOIN users u ON u.id = si.created_by
  LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
  ${INVOICE_WHERE}
  GROUP BY si.id, w.code, e.code, e.legal_name
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
    WHERE ${SYNC_CANDIDATE_PREDICATE}
    ORDER BY ${SYNC_CANDIDATE_ORDER}
    LIMIT ?
  `,

  /**
   * The same candidates, narrowed to what the caller is LOOKING at — the
   * invoices tab's own filter, so "sync these" and "show these" cannot drift.
   *
   * Takes INVOICE_WHERE's 15 params from buildInvoiceParams, which already
   * folds in the user's mfg / destination / brand scope. That is why this takes
   * a filter rather than a list of ids: a body of ids would have to be
   * re-checked one by one against scope (ids are guessable integers), whereas a
   * filter can only ever resolve to rows the caller can already see.
   * Parameters: [...buildInvoiceParams(...), limit]
   */
  selectForStatusSyncByFilter: `
    SELECT si.id, si.uniware_po_code, si.destination, si.buyer_gstin
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    ${INVOICE_WHERE}
      AND ${SYNC_CANDIDATE_PREDICATE}
    ORDER BY ${SYNC_CANDIDATE_ORDER}
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
           w.code AS destination_code,
           e.code AS entity_code, e.legal_name AS entity_name,
           si.uniware_po_code,
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
    LEFT  JOIN master_warehouse w ON w.name = si.destination
    -- The legal entity BILLED, matched on PAN — never the full GSTIN. The same
    -- entity registered in another state differs only in the leading two
    -- characters, so the state code does not identify it. Mirrors panOf()
    -- (gstin.slice(2,12)) and the rule facilityForInvoice already follows.
    LEFT  JOIN master_entity e ON e.pan = SUBSTRING(si.buyer_gstin, 3, 10)
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
           -- The rate the inward PO was raised at, beside the rate the invoice
           -- billed. They are written from each other at inward time, so a
           -- difference means one of them was edited since — which is exactly
           -- what the desk needs to see before approving a payment.
           inw.unit_price AS po_unit_price,
           -- Unicommerce's own view of this line, mirrored onto the inward PO by
           -- the status sync. Only the two with no local equivalent: received and
           -- rejected already come from grn_items_uniware below, and the same
           -- quantity under two names is how a reader stops trusting either.
           -- NULL means never asked, which un_line_synced_at distinguishes from 0.
           inw.un_pending_qty    AS un_pending_qty,
           inw.un_qc_pass_qty    AS un_qc_pass_qty,
           inw.un_line_synced_at AS un_line_synced_at,
           ref.po_no    AS received_against_po_no,
           ref.qty      AS received_against_qty,
           ref.received_qty AS received_against_received_qty,
           -- The ORDER's own rate. NULL on every one of the 123 procurement POs
           -- imported by direct SQL, so this reads as a dash until POs start
           -- being raised with a price — shown anyway, because "we never agreed
           -- a rate on this order" is itself worth seeing next to what we were
           -- billed.
           ref.unit_price AS received_against_unit_price,
           -- ── What the warehouse accepted against THIS line ────────────────
           -- Keyed on sii.po_id, the inward PO this line raised. That resolves
           -- 1:1 only because mergeInwardLinesBySku raises one inward PO per
           -- SKU, which is the same join grn_items_uniware.po_id was written
           -- for — so a line and its receipts always mean the same SKU.
           --
           -- Scalar subqueries, not joins: this query is one row per line, and
           -- a receipt can carry several lines for one PO, so a join would
           -- duplicate the invoice line itself.
           (SELECT COALESCE(SUM(gi.quantity - gi.rejected_qty), 0)
              FROM grn_items_uniware gi
             WHERE gi.po_id = sii.po_id) AS grn_accepted,
           (SELECT COALESCE(SUM(gi.rejected_qty), 0)
              FROM grn_items_uniware gi
             WHERE gi.po_id = sii.po_id) AS grn_rejected
    FROM invoice_items_mfg sii
    LEFT JOIN purchase_orders inw ON inw.id = sii.po_id
    LEFT JOIN purchase_orders ref ON ref.id = sii.received_against_po_id
    WHERE sii.invoice_id = ?
    ORDER BY sii.line_no
  `,

  /**
   * The goods receipts booked against one invoice, line by line.
   *
   * A flat join rather than two round trips: a handful of rows, and the header
   * fields repeat per line so the client can group by grn_code without a second
   * query. Ordered newest receipt first, matching how the invoice list reads.
   *
   * `sku_code` comes from the receipt, NOT from our invoice line — they can
   * disagree, and when they do that is the finding. `po_id IS NULL` rows are
   * included deliberately: a receipt for a SKU we never raised still belongs to
   * this invoice's Uniware PO, and hiding it would hide the discrepancy.
   * Parameters: [invoice_id]
   */
  selectGrnsByInvoiceId: `
    SELECT g.grn_code, g.status_code, g.vendor_invoice_no, g.grn_created_at,
           i.line_no, i.sku_code, i.po_id, i.quantity, i.rejected_qty,
           i.batch_code, i.expiry, i.mfg_date,
           po.po_no,
           -- A receipt carries no price of its own — Uniware does not report one
           -- on an inflow line. This is OUR rate: the inward PO's unit_price,
           -- written from the invoice at inward time, which is the number a
           -- debit note would be raised against. NULL stays NULL, so an
           -- unpriced line reads as unknown value rather than zero.
           po.unit_price AS po_unit_price
    FROM grn_uniware g
    INNER JOIN grn_items_uniware i ON i.grn_id = g.id
    LEFT  JOIN purchase_orders po  ON po.id   = i.po_id
    WHERE g.invoice_id = ?
    ORDER BY g.grn_created_at DESC, g.id DESC, i.line_no ASC
  `,

  /**
   * The match figures for EVERY invoice the filter matches, for the summary
   * strip above the list.
   *
   * Deliberately not paginated and deliberately narrow: the badge is derived in
   * TypeScript by threeWayMatch, so a summary counted in SQL would be a second
   * implementation of the tolerance and verification rules, free to drift from
   * the chips it sits above. Fetching the inputs and reducing them once keeps
   * one definition.
   *
   * Capped at 5,000 rows. 55 invoices exist today, so the cap is a guard rather
   * than a limit — but the strip says so when it bites rather than quietly
   * summarising part of the set.
   * Parameters: buildInvoiceParams(...) (15), then the cap
   */
  selectMatchFields: `
    SELECT si.id, si.invoice_total,
           COUNT(sii.id)             AS item_count,
           COALESCE(SUM(sii.qty), 0) AS billed_qty,
           COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent, 0) / 100)), 0) AS lines_value,
           COALESCE(SUM(sii.id IS NOT NULL AND sii.received_against_po_id IS NULL), 0) AS po_unlinked_lines,
           (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
           (SELECT COALESCE(SUM(i.quantity - i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_accepted,
           (SELECT COALESCE(SUM(i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_rejected,
           (SELECT COUNT(DISTINCT po.id) FROM invoice_items_mfg x
              JOIN purchase_orders po ON po.id = x.received_against_po_id
             WHERE x.invoice_id = si.id) AS po_count,
           (SELECT GROUP_CONCAT(v.leg ORDER BY v.leg) FROM invoice_leg_verification v
             WHERE v.invoice_id = si.id) AS verified_legs
    FROM invoice_mfg si
    INNER JOIN master_mfgs m ON m.id = si.mfg_id
    LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
    ${INVOICE_WHERE}
    GROUP BY si.id
    LIMIT ?
  `,

  /**
   * Just the figures threeWayMatch() reads, for one invoice.
   *
   * A narrow twin of the list query's match columns, so the verify route can
   * re-derive server-side whether a leg is even on file. Kept beside them
   * deliberately: change one and this must change with it, or the screen and
   * the guard will disagree about what is signable.
   * Parameters: [invoice_id]
   */
  selectInvoiceForMatch: `
    SELECT si.id, si.invoice_total,
           COUNT(sii.id)             AS item_count,
           COALESCE(SUM(sii.qty), 0) AS billed_qty,
           COALESCE(SUM(sii.amount * (1 + COALESCE(sii.gst_percent, 0) / 100)), 0) AS lines_value,
           COALESCE(SUM(sii.id IS NOT NULL AND sii.received_against_po_id IS NULL), 0) AS po_unlinked_lines,
           (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
           (SELECT COALESCE(SUM(i.quantity - i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_accepted,
           (SELECT COALESCE(SUM(i.rejected_qty), 0) FROM grn_items_uniware i
              JOIN grn_uniware g ON g.id = i.grn_id WHERE g.invoice_id = si.id) AS grn_rejected,
           (SELECT COUNT(DISTINCT po.id) FROM invoice_items_mfg x
              JOIN purchase_orders po ON po.id = x.received_against_po_id
             WHERE x.invoice_id = si.id) AS po_count
    FROM invoice_mfg si
    LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
    WHERE si.id = ?
    GROUP BY si.id
  `,

  /**
   * Who physically signed off which leg of one invoice's three-way match.
   * Parameters: [invoice_id]
   */
  selectLegVerifications: `
    SELECT v.leg, v.verified_at, v.remarks, v.verified_by, u.name AS verified_by_name
    FROM invoice_leg_verification v
    LEFT JOIN users u ON u.id = v.verified_by
    WHERE v.invoice_id = ?
    ORDER BY v.leg
  `,

  /**
   * Record a physical verification. Re-verifying the same leg OVERWRITES, so
   * "who last signed this off" has exactly one answer rather than a pile of
   * rows to sort — the audit trail for the action itself is activity_log.
   * Parameters: [invoice_id, leg, verified_by, remarks]
   */
  upsertLegVerification: `
    INSERT INTO invoice_leg_verification (invoice_id, leg, verified_by, remarks)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      verified_by = VALUES(verified_by),
      verified_at = CURRENT_TIMESTAMP,
      remarks     = VALUES(remarks)
  `,

  /** Withdraw a verification. Absence of a row IS unverified.
   *  Parameters: [invoice_id, leg] */
  deleteLegVerification: `
    DELETE FROM invoice_leg_verification WHERE invoice_id = ? AND leg = ?
  `,

  /** The hand-set payment state of one invoice, with who last moved it.
   *  Parameters: [invoice_id] */
  selectPayment: `
    SELECT p.invoice_id, p.status, p.utr, p.remarks, p.updated_at,
           p.updated_by, u.name AS updated_by_name
    FROM invoice_payment p
    LEFT JOIN users u ON u.id = p.updated_by
    WHERE p.invoice_id = ?
  `,

  /**
   * Move an invoice along the payment lifecycle. One row per invoice, so this
   * overwrites — activity_log holds the sequence of moves, this holds where it
   * is now.
   * Parameters: [invoice_id, status, utr, remarks, updated_by]
   */
  upsertPayment: `
    INSERT INTO invoice_payment (invoice_id, status, utr, remarks, updated_by)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status     = VALUES(status),
      utr        = VALUES(utr),
      remarks    = VALUES(remarks),
      updated_by = VALUES(updated_by)
  `,

  /** Hand the invoice back to the derived state. Parameters: [invoice_id] */
  deletePayment: `DELETE FROM invoice_payment WHERE invoice_id = ?`,
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
  /** invoice_mfg.uniware_status, or 'none' for never synced. */
  uniwareStatus?: string | null
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
    // Read three times: the IS NULL guard, the 'none' test, and the equality.
    f.uniwareStatus || null, f.uniwareStatus || null, f.uniwareStatus || null,
  ]
}
