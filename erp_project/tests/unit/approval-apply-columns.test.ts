// The generic apply path for master approvals. Both modules are DB-free: the
// connection is stubbed, so this only pins the SQL that gets built and the rule
// about which columns may reach it.

import { test } from "node:test"
import assert from "node:assert/strict"

import { applyApprovedColumns, type ColumnTarget } from "../../lib/approvals/handlers/apply-columns"
import { withStatusPreserved } from "../../lib/master-routes/status-preserve"

const TARGET: ColumnTarget = {
  table: "details_mfg",
  key: "mfg_id",
  columns: ["location", "gst_number", "status", "email"],
}

/** Captures what would have gone to MySQL. */
function stubConn() {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    conn: { execute: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [{}] } },
  }
}

test("only the columns the approval changed are written", async () => {
  const { conn, calls } = stubConn()
  await applyApprovedColumns(conn as never, TARGET, { location: "Pune", email: "a@b.com" }, 7)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].sql, "UPDATE details_mfg SET location = ?, email = ? WHERE mfg_id = ?")
  assert.deepEqual(calls[0].params, ["Pune", "a@b.com", 7])
})

test("a field not on the allow-list never reaches the SQL", async () => {
  // Field names come from approval_items, so this is the injection boundary.
  const { conn, calls } = stubConn()
  await applyApprovedColumns(
    conn as never, TARGET,
    { location: "Pune", "email = 'x', code": "boom", created_by: "9" }, 7
  )

  assert.equal(calls[0].sql, "UPDATE details_mfg SET location = ? WHERE mfg_id = ?")
  assert.deepEqual(calls[0].params, ["Pune", 7])
})

test("an override wins over the diff and is written even when absent from it", async () => {
  // This is what carries status out of in_review on approval.
  const { conn, calls } = stubConn()
  await applyApprovedColumns(conn as never, TARGET, { location: "Pune" }, 7, { status: "inactive" })

  assert.equal(calls[0].sql, "UPDATE details_mfg SET location = ?, status = ? WHERE mfg_id = ?")
  assert.deepEqual(calls[0].params, ["Pune", "inactive", 7])
})

test("a cleared field is written as NULL, not an empty string", async () => {
  const { conn, calls } = stubConn()
  await applyApprovedColumns(conn as never, TARGET, { email: "" }, 7)

  assert.deepEqual(calls[0].params, [null, 7])
})

test("nothing to write issues no statement at all", async () => {
  const { conn, calls } = stubConn()
  const written = await applyApprovedColumns(conn as never, TARGET, { unknown_field: "x" }, 7)

  assert.deepEqual(written, [])
  assert.equal(calls.length, 0)
})

// ── withStatusPreserved ──────────────────────────────────────────────────────

test("an unchanged inactive status is recorded so approval cannot reactivate it", async () => {
  const diff: [string, string][] = [["name", "New name"]]
  const out = withStatusPreserved(diff, { name: "New name", status: "inactive" }, "inactive")

  assert.deepEqual(out, [["name", "New name"], ["status", "inactive"]])
})

test("an active record gains no extra item", async () => {
  const diff: [string, string][] = [["name", "New name"]]
  const out = withStatusPreserved(diff, { name: "New name", status: "active" }, "active")

  assert.deepEqual(out, diff)
})

test("a status already in the diff is not duplicated", async () => {
  const diff: [string, string][] = [["status", "active"]]
  const out = withStatusPreserved(diff, { status: "active" }, "inactive")

  assert.deepEqual(out, diff)
})
