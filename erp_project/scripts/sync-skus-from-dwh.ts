/**
 * Sync master_skus + details_sku from the SKU data warehouse
 * (mcaff_dwh.All_Product_Name_MRP_Mapping).
 *
 * Why: master_skus/details_sku are what every SKU dropdown, PO create/edit,
 * and BOM picker reads from -- but in dev they were empty/stale while the
 * DWH table (wired up for the /masters/skus list page) is the current,
 * live source of SKU data. Rather than rewiring every read site to a second
 * database, this pushes the DWH data into master_skus/details_sku so all
 * existing queries keep working unchanged.
 *
 * The DWH table has multiple rows per Sku_code (one per external
 * marketplace/channel mapping key, e.g. ASIN, Shopify id) plus historical
 * price rows keyed by [start_date, end_date]. For each Sku_code we take the
 * row(s) from the latest end_date window (the currently-effective price
 * period), then MAX()-collapse any remaining duplicate rows within that
 * window (their core fields -- name/brand/category/mrp/hsn/sku_type -- are
 * identical in all but a handful of known data-quality exceptions).
 *
 * Same DB user (ERP_Tech_Admin) has grants on both schemas on the same
 * host, so this runs as plain cross-schema SQL -- no need to pull rows into
 * Node and re-insert them.
 *
 * Run: npx tsx scripts/sync-skus-from-dwh.ts
 */

import 'dotenv/config'
import { pool } from "../lib/db"
import { DB_NAME_SKU } from "../lib/env"

async function main() {
  const dwh = `\`${DB_NAME_SKU}\`.All_Product_Name_MRP_Mapping`
  const conn = await pool.getConnection()

  // One row per Sku_code: the currently-effective (latest end_date) window,
  // with any remaining duplicate rows in that window collapsed via MAX().
  // This is a plain derived table (not a CTE) -- MariaDB doesn't support
  // `WITH cte AS (...) INSERT INTO ...`, and the account has SELECT/INSERT/
  // UPDATE but not the separate CREATE TEMPORARY TABLES privilege, so a
  // real temp table isn't an option either.
  const CURRENT_SKU_SUBQUERY = `(
    SELECT
      d.Sku_code                                       AS sku_code,
      MAX(d.SKU_Name_Fixed)                             AS name,
      MAX(d.Brand)                                      AS brand,
      MAX(d.Category)                                   AS category,
      MAX(CASE
            WHEN d.Enabled = 'Yes'                         THEN 'active'
            WHEN d.Enabled = 'No' AND d.end_date < NOW()    THEN 'discontinued'
            ELSE 'inactive'
          END)                                           AS status,
      MAX(d.SKU_Type)                                   AS sku_type,
      MAX(d.MRP)                                        AS mrp,
      MAX(d.HSN)                                        AS hsn
    FROM ${dwh} d
    INNER JOIN (
      SELECT Sku_code, MAX(end_date) AS max_end
      FROM ${dwh}
      GROUP BY Sku_code
    ) latest ON latest.Sku_code = d.Sku_code AND latest.max_end <=> d.end_date
    WHERE d.Sku_code IS NOT NULL AND d.Sku_code != ''
      AND d.SKU_Name_Fixed IS NOT NULL AND d.SKU_Name_Fixed != ''
    GROUP BY d.Sku_code
  )`

  try {
    await conn.beginTransaction()

    const [countRows] = await conn.query(
      `SELECT COUNT(*) AS n FROM ${CURRENT_SKU_SUBQUERY} current_sku`
    )
    const candidateCount = (countRows as { n: number }[])[0].n
    console.log(`Candidate SKUs from DWH: ${candidateCount}`)

    const [skuResultRaw] = await conn.query(`
      INSERT INTO master_skus (sku_code, name, brand, category, status)
      SELECT sku_code, LEFT(name, 200), brand, category, status
      FROM ${CURRENT_SKU_SUBQUERY} current_sku
      ON DUPLICATE KEY UPDATE
        name     = VALUES(name),
        brand    = VALUES(brand),
        category = VALUES(category),
        -- Never clobber a SKU that's mid-approval (locked in_review).
        status   = IF(master_skus.status = 'in_review', master_skus.status, VALUES(status))
    `)
    const skuResult = skuResultRaw as { affectedRows: number }
    console.log(`master_skus affected rows: ${skuResult.affectedRows} (MySQL counts an update as 2)`)

    const [detailsResultRaw] = await conn.query(`
      INSERT INTO details_sku (sku_id, sku_type, mrp, hsn_code)
      SELECT ms.id, src.sku_type, src.mrp, src.hsn
      FROM ${CURRENT_SKU_SUBQUERY} src
      INNER JOIN master_skus ms ON ms.sku_code = src.sku_code
      ON DUPLICATE KEY UPDATE
        -- Don't overwrite sku_type once a row exists -- it may have been
        -- corrected by hand after the initial seed. Only refresh mrp/hsn,
        -- and only when the DWH actually has a value.
        mrp      = COALESCE(VALUES(mrp), details_sku.mrp),
        hsn_code = COALESCE(VALUES(hsn_code), details_sku.hsn_code)
    `)
    const detailsResult = detailsResultRaw as { affectedRows: number }
    console.log(`details_sku affected rows: ${detailsResult.affectedRows} (MySQL counts an update as 2)`)

    await conn.commit()
    console.log("Sync committed.")
  } catch (err) {
    await conn.rollback()
    console.error("Sync failed, rolled back:", err)
    process.exit(1)
  } finally {
    conn.release()
    await pool.end()
  }
}

main()
