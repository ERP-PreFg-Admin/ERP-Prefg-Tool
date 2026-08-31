// Read-only: verify every migration this session needs, on both schemas.
import mysql from "mysql2/promise"

async function main() {
  for (const schema of [process.env.DB_NAME_TEST!, process.env.DB_NAME_PROD!]) {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      database: schema, connectTimeout: 60000,
    })
    console.log(`\n════════ ${schema} ════════`)

    const [tabs] = await conn.query(
      `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('grn_uniware','grn_items_uniware')`)
    console.log("tables:")
    console.table(tabs)

    const [cols] = await conn.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE()
          AND ((TABLE_NAME='invoice_mfg'     AND COLUMN_NAME='uniware_grn_count')
            OR (TABLE_NAME='purchase_orders' AND COLUMN_NAME IN
                ('remarks','un_pending_qty','un_qc_pass_qty','un_line_synced_at')))
        ORDER BY TABLE_NAME, COLUMN_NAME`)
    console.log("columns:")
    console.table(cols)

    const [idx] = await conn.query(
      `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN ('uq_grn_code','uq_grn_line')
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)
    console.log("uniqueness rules:")
    console.table(idx)

    const [fks] = await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
          AND TABLE_NAME IN ('grn_uniware','grn_items_uniware')
        ORDER BY TABLE_NAME, CONSTRAINT_NAME`)
    console.log("foreign keys:")
    console.table(fks)

    const [g] = await conn.query(
      `SELECT role, page_slug, access_level FROM page_permissions WHERE page_slug='/uniware'`)
    console.log("/uniware grant:", (g as unknown[]).length ? JSON.stringify(g) : "NONE")

    // The two shapes the app actually runs. An error here is the real test.
    try {
      await conn.query(
        `SELECT si.id,
                (SELECT COUNT(*) FROM grn_uniware g WHERE g.invoice_id = si.id) AS grn_count,
                (SELECT COALESCE(SUM(i.rejected_qty),0) FROM grn_items_uniware i
                   JOIN grn_uniware g ON g.id=i.grn_id WHERE g.invoice_id=si.id) AS grn_rejected,
                COALESCE(SUM(sii.qty),0) AS billed_qty
           FROM invoice_mfg si
           LEFT JOIN invoice_items_mfg sii ON sii.invoice_id = si.id
          GROUP BY si.id LIMIT 1`)
      console.log("smoke: invoices list query      OK")
    } catch (e) { console.log("smoke: invoices list query      FAILS —", (e as Error).message) }

    try {
      await conn.query(
        `SELECT sii.*, inw.unit_price AS po_unit_price,
                inw.un_pending_qty, inw.un_qc_pass_qty, inw.un_line_synced_at,
                (SELECT COALESCE(SUM(gi.quantity),0) FROM grn_items_uniware gi
                  WHERE gi.po_id = sii.po_id) AS grn_accepted
           FROM invoice_items_mfg sii
           LEFT JOIN purchase_orders inw ON inw.id = sii.po_id LIMIT 1`)
      console.log("smoke: invoice expansion query  OK")
    } catch (e) { console.log("smoke: invoice expansion query  FAILS —", (e as Error).message) }

    try {
      await conn.query(
        `SELECT g.grn_code, g.status_code, g.vendor_invoice_no, g.grn_created_at,
                i.line_no, i.sku_code, i.po_id, i.quantity, i.rejected_qty,
                i.batch_code, i.expiry, i.mfg_date, po.po_no
           FROM grn_uniware g
           INNER JOIN grn_items_uniware i ON i.grn_id = g.id
           LEFT JOIN purchase_orders po ON po.id = i.po_id LIMIT 1`)
      console.log("smoke: receipts query           OK")
    } catch (e) { console.log("smoke: receipts query           FAILS —", (e as Error).message) }

    await conn.end()
  }
}
main().catch((e) => { console.error(e.message); process.exit(1) })
