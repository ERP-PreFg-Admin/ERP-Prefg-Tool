// warehouseHandler is the piece that routes a FLAT approval diff back into two
// tables: master_warehouse, plus one details_warehouse_entity row per legal
// entity. Three things here are worth protecting, and all three fail silently
// rather than loudly if they break.
//
// Run with `npm run test:db` — never a bare `tsx --test`. See tests/helpers/db.ts
// for why (lib/env.ts reads process.env at module load).
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { withRollback, closePool } from "../helpers/db"
import { warehouseHandler } from "../../lib/approvals/handlers/warehouses"
import { warehouse as warehouseSql } from "../../lib/queries/warehouse"
import type { PoolConnection } from "mysql2/promise"

// Without this the run hangs: node:test won't exit while the pool holds sockets.
// Every other file in tests/db/ does the same.
after(closePool)

type Row = Record<string, unknown>

/** An arbitrary existing location, plus the entity ids to hang child rows off. */
async function fixture(conn: PoolConnection) {
  const [whRows] = await conn.execute(
    "SELECT id, name, location, state, zone, type, status FROM master_warehouse ORDER BY id LIMIT 1"
  )
  const wh = (whRows as Row[])[0]
  assert.ok(wh, "expected at least one master_warehouse row — run prisma/backfill_warehouse_data.sql")

  const [entRows] = await conn.execute("SELECT id, code FROM master_entity ORDER BY code")
  const entities = entRows as { id: number; code: string }[]
  assert.ok(entities.length >= 2, "expected PEP and KREATIVE in master_entity")
  return { wh, entities }
}

const readWarehouse = async (conn: PoolConnection, id: number) => {
  const [rows] = await conn.execute(warehouseSql.selectById, [id])
  return (rows as Row[])[0]
}

const readEntityRow = async (conn: PoolConnection, id: number, code: string) => {
  const [rows] = await conn.execute(warehouseSql.selectEntityRowByCode, [id, code])
  return (rows as Row[])[0]
}

test("a `name` item in the diff is ignored — the join key never changes", async () => {
  // master_warehouse.name is copied by value into purchase_orders.destination,
  // invoice_mfg.destination and entity_emails.entity_code with no FK anywhere, so
  // a rename orphans all three and nothing errors. warehouseSql.update omits
  // `name` from its SET list; this is what fails if someone adds it back.
  await withRollback(async (conn) => {
    const { wh } = await fixture(conn)
    const id = Number(wh.id)

    await warehouseHandler.applyAndArchive(
      conn,
      id,
      [
        { field_name: "name", old_value: String(wh.name), new_value: "RENAMED-BY-TEST" },
        { field_name: "state", old_value: String(wh.state ?? ""), new_value: "Test State" },
      ],
      1
    )

    const after = await readWarehouse(conn, id)
    assert.equal(after.name, wh.name, "name must be unchanged")
    assert.equal(after.state, "Test State", "a normal field must still apply")
  })
})

test("a per-entity diff touches only that entity's row", async () => {
  // The whole point of the child table: one location, two entities, different
  // facility codes. A handler that wrote both rows from one diff would quietly
  // point Kreative's POs at Pep's Unicommerce facility.
  await withRollback(async (conn) => {
    const { wh, entities } = await fixture(conn)
    const id = Number(wh.id)
    const [a, b] = entities
    const before = await readEntityRow(conn, id, b.code)

    await warehouseHandler.applyAndArchive(
      conn,
      id,
      [{ field_name: `facility_code:${a.code}`, old_value: "", new_value: "TEST_FACILITY_A" }],
      1
    )

    const rowA = await readEntityRow(conn, id, a.code)
    const rowB = await readEntityRow(conn, id, b.code)
    assert.equal(rowA.facility_code, "TEST_FACILITY_A")
    assert.equal(
      rowB?.facility_code ?? null,
      before?.facility_code ?? null,
      `${b.code}'s facility must not change when only ${a.code} was edited`
    )
  })
})

test("a cleared field stores NULL, not an empty string", async () => {
  // approval_items.new_value is a VARCHAR, so a cleared field arrives as "".
  // Storing that verbatim would make facility_code = '' — which reads as
  // "configured" to anything checking IS NULL, while Uniware would reject it.
  await withRollback(async (conn) => {
    const { wh, entities } = await fixture(conn)
    const id = Number(wh.id)
    const code = entities[0].code

    await warehouseHandler.applyAndArchive(
      conn,
      id,
      [{ field_name: `facility_code:${code}`, old_value: "X", new_value: "" }],
      1
    )

    const row = await readEntityRow(conn, id, code)
    assert.equal(row.facility_code, null, "cleared facility_code must be NULL, not ''")
  })
})

test("approving clears in_review off the location even when only a child row changed", async () => {
  // Otherwise the location stays locked and the submitter can never edit it
  // again — the master UPDATE has to run unconditionally.
  await withRollback(async (conn) => {
    const { wh, entities } = await fixture(conn)
    const id = Number(wh.id)
    await conn.execute(warehouseSql.setStatus, ["in_review", id])

    await warehouseHandler.applyAndArchive(
      conn,
      id,
      [{ field_name: `gstin:${entities[0].code}`, old_value: "", new_value: "27AAJCK9697F1ZS" }],
      1
    )

    const after = await readWarehouse(conn, id)
    assert.equal(after.status, "active")
  })
})
