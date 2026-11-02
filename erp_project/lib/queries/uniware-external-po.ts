// uniware_external_po — Uniware POs at our facilities that no live ERP invoice owns. See prisma/add_uniware_external_po.sql.

// A row's live adoption: set, and the invoice it points at not reverted.
const ADOPTED_LIVE = `(x.adopted_invoice_id IS NOT NULL AND ai.reverted_at IS NULL)`

// The live ERP invoice carrying the same number, with or without the note after it.
const LIVE_INVOICE_JOIN = `
  LEFT JOIN invoice_mfg li
    ON li.mfg_id = x.mfg_id AND li.reverted_at IS NULL
   AND li.invoice_no IN (x.reference_no, SUBSTRING_INDEX(x.reference_no, ' ', 1))
   AND (li.uniware_po_code IS NULL OR li.uniware_po_code <> x.uniware_po_code)`

const CANDIDATE_COLUMNS = `
  x.id, x.uniware_po_code, x.facility_code, x.vendor_code, x.mfg_id, m.code AS mfg_code, m.name AS mfg_name,
  x.reference_no, x.un_status, x.grn_count, x.un_created_by, x.un_created_at, x.all_fg, x.items,
  ${ADOPTED_LIVE} AS adopted,
  MIN(li.invoice_no) AS live_invoice_no, MIN(li.uniware_po_code) AS live_invoice_uniware_po_code`

export const uniwareExternalPoSql = {
  /** Codes a live ERP invoice already owns — never cached. Takes the facility's code list. */
  selectOwnedCodes: `
    SELECT DISTINCT uniware_po_code AS code FROM invoice_mfg
     WHERE reverted_at IS NULL AND uniware_po_code IN (?)`,

  /** Cached rows among a code list, with whether each still needs a fresh detail call. */
  selectCachedAmong: `
    SELECT x.uniware_po_code AS code, x.mfg_id, ${ADOPTED_LIVE} AS adopted, x.un_status
      FROM uniware_external_po x
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
     WHERE x.uniware_po_code IN (?)`,

  /** Vendor code → manufacturer at one facility: the facility map first, master code as fallback. */
  selectMfgVendorCodes: `
    SELECT UPPER(x.un_mfg_code) AS code, MIN(x.mfg_id) AS mfg_id
      FROM un_code_mfg_sku_wh_map x
      JOIN details_warehouse_entity d ON d.id = x.wh_id
     WHERE d.facility_code = ? AND x.status = 'active' AND x.un_mfg_code IS NOT NULL AND x.un_mfg_code <> ''
     GROUP BY UPPER(x.un_mfg_code)
    UNION ALL
    SELECT UPPER(code), id FROM master_mfgs WHERE code IS NOT NULL AND code <> ''`,

  selectFgSkuCodes: `SELECT sku_code FROM master_skus WHERE sku_code IN (?)`,

  upsert: `
    INSERT INTO uniware_external_po
      (uniware_po_code, facility_code, vendor_code, mfg_id, reference_no, un_status, grn_count,
       un_created_by, un_created_at, all_fg, items)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      facility_code = VALUES(facility_code), vendor_code = VALUES(vendor_code), mfg_id = VALUES(mfg_id),
      reference_no = VALUES(reference_no), un_status = VALUES(un_status), grn_count = VALUES(grn_count),
      un_created_by = VALUES(un_created_by), un_created_at = VALUES(un_created_at),
      all_fg = VALUES(all_fg), items = VALUES(items), synced_at = CURRENT_TIMESTAMP`,

  /** Re-resolves rows cached as non-manufacturer once their vendor code is mapped. Params: [facility, facility]. */
  reresolveMfg: `
    UPDATE uniware_external_po x
      JOIN (
        SELECT UPPER(w.un_mfg_code) AS code, MIN(w.mfg_id) AS mfg_id
          FROM un_code_mfg_sku_wh_map w
          JOIN details_warehouse_entity d ON d.id = w.wh_id
         WHERE d.facility_code = ? AND w.status = 'active' AND w.un_mfg_code IS NOT NULL
         GROUP BY UPPER(w.un_mfg_code)
      ) v ON v.code = UPPER(x.vendor_code)
       SET x.mfg_id = v.mfg_id
     WHERE x.facility_code = ? AND x.mfg_id IS NULL`,

  /** Manufacturer rows from one facility sweep, for the button's summary. Params: [facility, since]. */
  selectForFacility: `
    SELECT ${CANDIDATE_COLUMNS}
      FROM uniware_external_po x
      JOIN master_mfgs m ON m.id = x.mfg_id
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
      ${LIVE_INVOICE_JOIN}
     WHERE x.facility_code = ? AND x.un_created_at >= ?
     GROUP BY x.id
     ORDER BY x.un_created_at`,

  /** Adopt picker: one manufacturer's not-yet-adopted rows from the last `since`. Params: [mfg_id, since]. */
  selectCandidatesByMfg: `
    SELECT ${CANDIDATE_COLUMNS}
      FROM uniware_external_po x
      JOIN master_mfgs m ON m.id = x.mfg_id
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
      ${LIVE_INVOICE_JOIN}
     WHERE x.mfg_id = ? AND x.un_created_at >= ?
     GROUP BY x.id
    HAVING adopted = 0
     ORDER BY x.un_created_at DESC`,

  /** One row for the adopt commit, locked. */
  selectByCodeForUpdate: `
    SELECT x.id, x.uniware_po_code, x.facility_code, x.mfg_id, x.all_fg, x.items,
           ${ADOPTED_LIVE} AS adopted
      FROM uniware_external_po x
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
     WHERE x.uniware_po_code = ?
       FOR UPDATE OF x`,

  selectByCode: `
    SELECT x.id, x.uniware_po_code, x.facility_code, x.mfg_id, x.all_fg, x.items,
           ${ADOPTED_LIVE} AS adopted
      FROM uniware_external_po x
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
     WHERE x.uniware_po_code = ?`,

  /** Claims the row for an invoice. 0 affected rows = someone else adopted it first. Params: [invoice_id, id]. */
  markAdopted: `
    UPDATE uniware_external_po x
      LEFT JOIN invoice_mfg ai ON ai.id = x.adopted_invoice_id
       SET x.adopted_invoice_id = ?
     WHERE x.id = ? AND (x.adopted_invoice_id IS NULL OR ai.reverted_at IS NOT NULL)`,

  /** Active facilities, for the button's per-facility loop. */
  selectFacilities: `
    SELECT DISTINCT facility_code FROM details_warehouse_entity
     WHERE status = 'active' AND facility_code IS NOT NULL AND facility_code <> ''
     ORDER BY facility_code`,
}
