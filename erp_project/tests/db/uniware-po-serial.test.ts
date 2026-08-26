import test, { after } from "node:test"
import assert from "node:assert/strict"
import type { PoolConnection } from "mysql2/promise"
import { withRollback, closePool } from "../helpers/db"
import { nextSerial } from "../../lib/uniware/po-serial"

after(closePool)

/** One invoice_mfg row carrying a uniware_po_code, so nextSerial has something
 *  to read. Inserted through the caller's connection so it rolls back. */
async function stampCode(conn: PoolConnection, code: string, n: number) {
  const [mfg] = await conn.execute("SELECT id FROM master_mfgs ORDER BY id LIMIT 1")
  const mfgId = (mfg as { id: number }[])[0]?.id
  assert.ok(mfgId, "need at least one row in master_mfgs")
  await conn.execute(
    `INSERT INTO invoice_mfg (mfg_id, invoice_no, uniware_po_code, created_by)
     VALUES (?, ?, ?, 1)`,
    [mfgId, `PO-SERIAL-TEST-${process.pid}-${n}`, code]
  )
}

test("seed alone is the floor when the series is empty", async () => {
  await withRollback(async (conn) => {
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: 5651 }), 5652)
    // No seed and no codes means the series starts at 1.
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: null }), 1)
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: 0 }), 1)
  })
})

test("an existing code above the seed wins; the seed is a floor, not a start", async () => {
  await withRollback(async (conn) => {
    await stampCode(conn, "M/ZZZ9/2627/05660", 1)
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: 5651 }), 5661)
    // ...and a stale seed below the high-water mark is simply ignored, which is
    // why leaving it in place after cutover is harmless.
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: 1 }), 5661)
  })
})

test("MAX and not COUNT: a gap in the series does not reissue a used number", async () => {
  await withRollback(async (conn) => {
    await stampCode(conn, "M/ZZZ9/2627/00001", 1)
    await stampCode(conn, "M/ZZZ9/2627/00009", 2)
    // COUNT(*)+1 would answer 3 here — a number already inside the used range.
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: null }), 10)
  })
})

test("other facilities and other financial years are out of range", async () => {
  await withRollback(async (conn) => {
    await stampCode(conn, "M/ZZZ9/2627/00004", 1)
    await stampCode(conn, "H/ZZZ9/2627/09999", 2)   // other entity letter
    await stampCode(conn, "M/ZZZ8/2627/09999", 3)   // other facility
    await stampCode(conn, "M/ZZZ9/2526/09999", 4)   // previous FY
    // The FY is inside the prefix, which is what makes the series restart every
    // April by construction rather than by a reset step.
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: null }), 5)
  })
})

test("a code with no numeric tail is ignored rather than throwing", async () => {
  await withRollback(async (conn) => {
    // Uniware-assigned codes are still in this column from before the cutover.
    await stampCode(conn, "M/ZZZ9/2627/API", 1)
    await stampCode(conn, "M/ZZZ9/2627/00003", 2)
    assert.equal(await nextSerial(conn, { prefix: "M/ZZZ9/2627", seed: null }), 4)
  })
})
