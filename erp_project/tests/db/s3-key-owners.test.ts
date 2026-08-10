// The owner lookup behind lib/s3-guard.ts — s3FilesSql.selectKeyOwners.
//
// Two things are proven here that a unit test cannot: the UNION ALL is valid SQL
// against the real schema (every branch names a table and columns that exist),
// and KEY_OWNER_PARAM_COUNT matches the number of `?` the query actually wants —
// a mismatch makes mysql2 throw, so any run at all is that assertion.
//
// The query is run on the test's own connection rather than through
// assertKeyReadable(), which uses lib/db's pool: a fixture row inside an
// uncommitted transaction is invisible to any other connection. The scope
// decision assertKeyReadable layers on top is pure — see tests/unit/scope.test.ts.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { s3FilesSql, KEY_OWNER_PARAM_COUNT } from "../../lib/queries/s3-files"
import { inScope, UNRESTRICTED } from "../../lib/scope"
import { withRollback, anchors, makePo, closePool } from "../helpers/db"
import type { PoolConnection } from "mysql2/promise"

after(closePool)

type Owner = { mfg_id: number | null; destination: string | null }

async function ownersOf(conn: PoolConnection, key: string): Promise<Owner[]> {
  const [rows] = await conn.query(
    s3FilesSql.selectKeyOwners,
    Array(KEY_OWNER_PARAM_COUNT).fill(key)
  )
  return rows as Owner[]
}

test("a PO attachment key resolves to its PO's scope dimensions", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no manufacturer/SKU/user in the test schema")

    const key = `po-attachments/qa-${process.pid}.pdf`
    const po = await makePo(conn, a, { qty: 10, destination: "QA Warehouse" })
    await conn.execute(s3FilesSql.updatePoAttachment, [key, po.id])

    const owners = await ownersOf(conn, key)
    assert.equal(owners.length, 1)
    assert.equal(owners[0].mfg_id, po.mfg_id)
    assert.equal(owners[0].destination, "QA Warehouse")
  })
})

test("a key owned by nothing resolves to no owner at all", async (t) => {
  await withRollback(async (conn) => {
    // The enumeration block: assertKeyReadable turns an empty result into a 403,
    // so guessing another manufacturer's attachment_key is no longer enough.
    const owners = await ownersOf(conn, `nope/does-not-exist-${process.pid}.pdf`)
    assert.equal(owners.length, 0)
    void t
  })
})

test("the bulk-import CSV a PO came from is readable too", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    // One CSV is the source of many POs, so this legitimately returns a row per PO.
    const key = `imports/PO/qa-${process.pid}.csv`
    const po = await makePo(conn, a, { qty: 5 })
    await conn.execute("UPDATE purchase_orders SET csv_source_key = ? WHERE id = ?", [key, po.id])

    const owners = await ownersOf(conn, key)
    assert.equal(owners.length, 1)
    assert.equal(owners[0].mfg_id, po.mfg_id)
  })
})

test("an out-of-scope owner is what blocks the read", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")

    const key = `po-attachments/qa-scope-${process.pid}.pdf`
    const po = await makePo(conn, a, { qty: 10 })
    await conn.execute(s3FilesSql.updatePoAttachment, [key, po.id])

    const [owner] = await ownersOf(conn, key)
    // The two halves of assertKeyReadable's decision, applied to a real owner row.
    assert.ok(inScope(UNRESTRICTED, "mfg", owner.mfg_id), "an unscoped user reads everything, as before")
    assert.equal(
      inScope({ mfgIds: [po.mfg_id + 1000], vendorIds: null, warehouseNames: null }, "mfg", owner.mfg_id),
      false,
      "a user scoped to some other manufacturer does not"
    )
  })
})
