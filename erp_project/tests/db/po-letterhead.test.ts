// selectForEmail grew four LEFT JOINs to resolve which legal entity a PO is from.
// This file exists for one reason: to prove they stayed LEFT.
//
// Turn any of them into an INNER JOIN and the query returns no row for a PO whose
// SKU is unattributed, whose brand has no entity, or whose warehouse has no row
// for that entity. fetchPoData then returns null, which surfaces as a 404 on the
// PDF preview and as a SILENTLY missing attachment on the manufacturer email
// (lib/mail/mailer.ts catches, logs and sends anyway). Nothing type-checks that.
//
// The resolvers themselves are covered without a DB in tests/unit/po-letterhead
// .test.ts; what can only be checked here is that the SQL actually delivers the
// columns those resolvers read — query<T> is an unchecked cast, so a mistyped
// alias compiles, lints, and reads back undefined.
//
// Run with `npm run test:db` — never a bare `tsx --test`; see tests/helpers/db.ts.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection, ResultSetHeader } from "mysql2/promise"
import { withRollback, closePool, anchors, makePo } from "../helpers/db"
import { purchaseOrdersSql } from "../../lib/queries/purchase-orders"
import { resolveLetterhead, resolveShipTo, type PoEmailRow } from "../../lib/pdf/po-letterhead"
import { destinationAllowed, type DestinationEntityRow } from "../../lib/po/po-guard"

// node:test won't exit while the pool holds sockets.
after(closePool)

/**
 * Fails with the migration name rather than a bare "Unknown column", which is
 * what you get for the first hour otherwise.
 */
async function assertMigrated(conn: PoolConnection) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_entity'
        AND COLUMN_NAME IN ('bank_name','bank_account_no','bank_ifsc','bank_branch')`
  )
  assert.equal(
    (rows as unknown[]).length, 4,
    "master_entity is missing the bank columns — run prisma/add_entity_bank_details.sql"
  )
}

const readForEmail = async (conn: PoolConnection, poId: number): Promise<PoEmailRow[]> => {
  const [rows] = await conn.query(purchaseOrdersSql.selectForEmail, [poId])
  return rows as PoEmailRow[]
}

/**
 * Delete this warehouse's per-entity rows, clearing what references them first.
 *
 * These tests own their facility rows outright (DELETE then INSERT, so no
 * pre-existing address column leaks into an assertion — see the note at the first
 * call site). That worked while nothing referenced `details_warehouse_entity`.
 * `un_code_mfg_sku_wh_map.wh_id` now does, and once the MFG × facility map is
 * populated the DELETE fails on `fk_map_wh` — so the dependents have to go in the
 * same breath. Both happen inside the rolled-back transaction, so nothing real is
 * lost either way.
 *
 * Pass `entityId` to narrow to one entity's row, matching the two call shapes.
 */
async function clearFacilityRows(
  conn: PoolConnection,
  warehouseId: number,
  entityId?: number
) {
  const where = entityId == null
    ? { sql: "warehouse_id = ?", params: [warehouseId] }
    : { sql: "warehouse_id = ? AND entity_id = ?", params: [warehouseId, entityId] }

  await conn.execute(
    `DELETE FROM un_code_mfg_sku_wh_map
      WHERE wh_id IN (SELECT id FROM details_warehouse_entity WHERE ${where.sql})`,
    where.params
  )
  await conn.execute(`DELETE FROM details_warehouse_entity WHERE ${where.sql}`, where.params)
}

/** An entity, a brand attributed to it, and a warehouse — or null to skip. */
async function fixtures(conn: PoolConnection) {
  const [entRows] = await conn.execute("SELECT id, code FROM master_entity ORDER BY code LIMIT 1")
  const [whRows] = await conn.execute("SELECT id, name FROM master_warehouse ORDER BY id LIMIT 1")
  const [brRows] = await conn.execute("SELECT id FROM master_brand ORDER BY id LIMIT 1")

  const entity = (entRows as { id: number; code: string }[])[0]
  const warehouse = (whRows as { id: number; name: string }[])[0]
  const brand = (brRows as { id: number }[])[0]
  if (!entity || !warehouse || !brand) return null

  // Point the brand at this entity for the duration of the transaction, so the
  // test doesn't depend on which brands happen to be mapped in this schema.
  await conn.execute("UPDATE master_brand SET entity_id = ? WHERE id = ?", [entity.id, brand.id])
  return { entity, warehouse, brandId: brand.id }
}

test("the full chain resolves the site's own bill-to", async () => {
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])

    // DELETE then INSERT, not an upsert: an upsert only overwrites the columns it
    // lists, so any address column the real row already holds leaks into the
    // assertion. (ship_to_line2 did exactly that.) The transaction is rolled back,
    // so deleting the live row is safe and makes the fixture own every column.
    await clearFacilityRows(conn, f.warehouse.id, f.entity.id)
    await conn.execute<ResultSetHeader>(
      `INSERT INTO details_warehouse_entity
         (warehouse_id, entity_id, facility_code, bill_to_name, bill_to_address, bill_to_gstin,
          ship_to_name, ship_to_line1, ship_to_line2, ship_to_city, ship_to_state,
          ship_to_pincode, ship_to_gstin, ship_to_address, status)
       VALUES (?, ?, 'QA_FAC', 'QA Legal Name', 'QA Line 1\nQA Line 2', '18ABGCS1450A1ZK',
               'QA Consignee', 'QA Warehouse 4', NULL, 'Guwahati', 'Assam',
               '781031', '18AAICP2804J1Z9', NULL, 'active')`,
      [f.warehouse.id, f.entity.id]
    )

    const po = await makePo(conn, a, { qty: 10, destination: f.warehouse.name })
    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1, "exactly one row — the joins must not multiply it")

    // The aliases actually arrived. This is the assertion query<T> cannot make.
    assert.equal(rows[0].entity_code, f.entity.code)
    assert.equal(rows[0].bill_to_gstin, "18ABGCS1450A1ZK")

    const lh = resolveLetterhead(rows[0])
    assert.equal(lh.entity_code, f.entity.code)
    assert.equal(lh.name, "QA Legal Name")
    assert.deepEqual(lh.address_lines, ["QA Line 1", "QA Line 2"])
    assert.equal(lh.gstin, "18ABGCS1450A1ZK")

    const ship = resolveShipTo(rows[0])
    assert.equal(ship.name, "QA Consignee")
    assert.deepEqual(ship.address_lines, ["QA Warehouse 4", "Guwahati, Assam - 781031"])
    // The consignee registration, NOT the bill-to — they differ by design.
    assert.equal(ship.gstin, "18AAICP2804J1Z9")
  })
})

test("a site with no bill-to prints the right company and no address", async () => {
  // There is deliberately no entity-level address to fall back to: it would be
  // wrong for any delivery outside the entity's home state. Incomplete gets
  // reported; wrong-but-plausible gets filed.
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    await clearFacilityRows(conn, f.warehouse.id, f.entity.id)

    const po = await makePo(conn, a, { qty: 10, destination: f.warehouse.name })
    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1, "a missing per-entity row must not drop the PO")

    const lh = resolveLetterhead(rows[0])
    assert.equal(lh.entity_code, f.entity.code)
    assert.equal(lh.name, rows[0].entity_legal_name, "the legal name still resolves")
    assert.deepEqual(lh.address_lines, [])
    assert.equal(lh.gstin, null)

    // Ship-to has nothing structured to use, so it degrades to what the PDF
    // printed before any of this existed.
    assert.equal(resolveShipTo(rows[0]).name, f.warehouse.name)
  })
})

test("an unattributed SKU still returns a row — the LEFT JOIN regression", async () => {
  // The one that matters. brand_id NULL is the normal state of most SKUs.
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = NULL WHERE sku_code = ?", [a.sku])
    const po = await makePo(conn, a, { qty: 10, destination: f.warehouse.name })

    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1, "an unattributed SKU must still produce a PDF, not a 404")
    assert.equal(rows[0].entity_code, null)
    // Falls all the way to what every PO printed before entities existed.
    assert.equal(resolveLetterhead(rows[0]).name, "Pep Technologies Pvt Ltd, MCaffeine")
  })
})

test("a brand with no legal entity still returns a row", async () => {
  // DND's entity_id is NULL. The SKU has a brand; the brand has no entity.
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_brand SET entity_id = NULL WHERE id = ?", [f.brandId])
    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    const po = await makePo(conn, a, { qty: 10, destination: f.warehouse.name })

    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1, "a brand with no entity must not drop the PO")
    assert.equal(rows[0].entity_code, null)
  })
})

test("a PO with no destination still returns a row", async () => {
  // Impromptu POs can carry destination NULL, so master_warehouse and
  // details_warehouse_entity both resolve to nothing.
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    const po = await makePo(conn, a, { qty: 10, destination: null })

    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1, "destination NULL must still produce a PDF")
    // The entity resolves through the SKU, which does not depend on the warehouse.
    assert.equal(rows[0].entity_code, f.entity.code)
    assert.equal(rows[0].bill_to_gstin, null)
  })
})

test("an inactive per-entity row is ignored, not printed", async () => {
  // The join carries `AND dwe.status = 'active'`. Without it a decommissioned
  // registration keeps appearing on new POs.
  await withRollback(async (conn) => {
    await assertMigrated(conn)
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    await conn.execute(
      `INSERT INTO details_warehouse_entity (warehouse_id, entity_id, bill_to_gstin, status)
       VALUES (?, ?, '18ABGCS1450A1ZK', 'inactive')
       ON DUPLICATE KEY UPDATE bill_to_gstin = VALUES(bill_to_gstin), status = 'inactive'`,
      [f.warehouse.id, f.entity.id]
    )
    // The upsert is fine here — the assertion is that NOTHING comes back from this
    // row, so a leftover column in it can't produce a false pass.

    const po = await makePo(conn, a, { qty: 10, destination: f.warehouse.name })
    const rows = await readForEmail(conn, po.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].bill_to_gstin, null, "an inactive registration must not be billed")
  })
})

/* ── The create-PO destination guard ───────────────────────────────────────────
 * tests/unit/destination-entity.test.ts proves the RULE matches the dropdown's.
 * What only the DB can show is that the query feeding it returns the three facts
 * the rule reads — and in particular that `site_configured` distinguishes "this
 * site has no per-entity rows" from "this entity has none at this site". Collapse
 * those two and either every unconfigured site is refused, or the guard passes
 * everything.                                                                  */

const destCheck = async (
  conn: PoolConnection, skuCode: string, destination: string
): Promise<DestinationEntityRow> => {
  const [rows] = await conn.execute(
    purchaseOrdersSql.selectDestinationEntityCheck, [destination, destination, skuCode]
  )
  return (rows as DestinationEntityRow[])[0]
}

test("the guard refuses the other entity's site and allows its own", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    // Two entities, so there is an "other" one to be refused by.
    const [entRows] = await conn.execute("SELECT id, code FROM master_entity ORDER BY code")
    const entities = entRows as { id: number; code: string }[]
    if (entities.length < 2) return
    const [mine, other] = entities

    await conn.execute("UPDATE master_brand SET entity_id = ? WHERE id = ?", [mine.id, f.brandId])
    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])

    // This site is set up for the OTHER entity only.
    await clearFacilityRows(conn, f.warehouse.id)
    await conn.execute(
      `INSERT INTO details_warehouse_entity (warehouse_id, entity_id, facility_code, status)
       VALUES (?, ?, 'QA_OTHER', 'active')`,
      [f.warehouse.id, other.id]
    )

    const refused = await destCheck(conn, a.sku, f.warehouse.name)
    assert.equal(refused.entity_code, mine.code)
    assert.equal(Number(refused.site_configured), 1, "the site IS configured — for someone else")
    assert.equal(Number(refused.serves), 0)
    assert.equal(destinationAllowed(refused), false, "the other entity's site must be refused")

    // Add our own row and the same destination becomes valid.
    await conn.execute(
      `INSERT INTO details_warehouse_entity (warehouse_id, entity_id, facility_code, status)
       VALUES (?, ?, 'QA_MINE', 'active')`,
      [f.warehouse.id, mine.id]
    )
    assert.equal(destinationAllowed(await destCheck(conn, a.sku, f.warehouse.name)), true)
  })
})

test("a site with no per-entity rows is allowed, not refused", async () => {
  // The distinction site_configured exists for. Refusing here would block a
  // destination over a data gap invisible from the PO screen.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    await clearFacilityRows(conn, f.warehouse.id)

    const row = await destCheck(conn, a.sku, f.warehouse.name)
    assert.equal(Number(row.site_configured), 0)
    assert.equal(destinationAllowed(row), true)
  })
})

test("an INACTIVE row does not make a site count as configured for that entity", async () => {
  // Both EXISTS clauses filter status='active'. If only one did, a decommissioned
  // registration would either resurrect a destination or block a live one.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    const [entRows] = await conn.execute("SELECT id, code FROM master_entity ORDER BY code")
    const entities = entRows as { id: number; code: string }[]
    if (entities.length < 2) return
    const [mine, other] = entities

    await conn.execute("UPDATE master_brand SET entity_id = ? WHERE id = ?", [mine.id, f.brandId])
    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    await clearFacilityRows(conn, f.warehouse.id)

    // Our row is inactive; the other entity's is live.
    await conn.execute(
      `INSERT INTO details_warehouse_entity (warehouse_id, entity_id, status) VALUES (?, ?, 'inactive')`,
      [f.warehouse.id, mine.id]
    )
    await conn.execute(
      `INSERT INTO details_warehouse_entity (warehouse_id, entity_id, status) VALUES (?, ?, 'active')`,
      [f.warehouse.id, other.id]
    )

    const row = await destCheck(conn, a.sku, f.warehouse.name)
    assert.equal(Number(row.serves), 0, "an inactive row must not count as serving")
    assert.equal(destinationAllowed(row), false)
  })
})

test("an unattributed SKU is unrestricted, and an unknown SKU returns nothing", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = NULL WHERE sku_code = ?", [a.sku])
    const row = await destCheck(conn, a.sku, f.warehouse.name)
    assert.equal(row.entity_code, null)
    assert.equal(destinationAllowed(row), true)

    // No row at all — assertDestinationServesEntity returns early rather than
    // duplicating the create route's own sku_not_found error.
    assert.equal(await destCheck(conn, "ZZ-NO-SUCH-SKU", f.warehouse.name), undefined)
  })
})

test("an unknown destination name is not silently treated as configured", async () => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    const f = await fixtures(conn)
    if (!a || !f) return

    await conn.execute("UPDATE master_skus SET brand_id = ? WHERE sku_code = ?", [f.brandId, a.sku])
    const row = await destCheck(conn, a.sku, "ZZ No Such Warehouse")
    // Nothing matches the name, so the site reads as unconfigured and passes. The
    // create route's own warehouse-scope check is what rejects a bogus name.
    assert.equal(Number(row.site_configured), 0)
    assert.equal(destinationAllowed(row), true)
  })
})
