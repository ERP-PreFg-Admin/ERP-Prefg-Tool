import { test } from "node:test"
import assert from "node:assert/strict"
import { composeDocBatch } from "../../lib/uniware/doc-batch"

const ids = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => ({ id: from - i }))

test("an old unsent PDF gets a slot even when the newest invoices fill the run", () => {
  const { batch, truncated } = composeDocBatch([{ id: 789 }], ids(1260, 1200), 40)
  assert.equal(batch[0].id, 789)
  assert.equal(batch.length, 40)
  assert.equal(truncated, true)
})

test("retries are capped, so the newest still get the rest of the run", () => {
  const { batch } = composeDocBatch(ids(500, 401), ids(1260, 1200), 40, 20)
  assert.equal(batch.filter((r) => r.id <= 500).length, 20)
  assert.equal(batch.filter((r) => r.id >= 1200).length, 20)
})

test("an invoice that is both a retry and among the newest runs once", () => {
  const { batch, truncated } = composeDocBatch([{ id: 1259 }], ids(1260, 1255), 40)
  assert.deepEqual(batch.map((r) => r.id), [1259, 1260, 1258, 1257, 1256, 1255])
  assert.equal(truncated, false)
})

test("with no retries the run is the newest, as before", () => {
  const { batch } = composeDocBatch([], ids(1260, 1100), 40)
  assert.deepEqual(batch.map((r) => r.id), ids(1260, 1221).map((r) => r.id))
})
