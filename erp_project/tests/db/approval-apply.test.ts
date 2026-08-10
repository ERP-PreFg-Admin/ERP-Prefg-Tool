// Approval handlers — lib/approvals/handlers/*.ts `applyAndArchive`.
//
// This is where an approved diff actually lands on a master record. The
// properties that matter: the OLD value is archived before being overwritten,
// fields absent from the diff keep their current value, and a mid-way failure
// leaves nothing applied.
//
// Every case is rolled back. The handlers take the connection and never manage a
// transaction themselves — which is what makes this testable.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { MODULE_HANDLERS } from "../../lib/approvals/module-handlers"
import { supersededOn, type DiffItem } from "../../lib/approvals/handlers/types"
import {
  withRollback, anchors, makeRmMfgRate, readRmMfgRate, readMrmHistory, closePool, num, ymd, today,
} from "../helpers/db"

after(closePool)

const diff = (pairs: Record<string, string>): DiffItem[] =>
  Object.entries(pairs).map(([field_name, new_value]) => ({ field_name, old_value: "", new_value }))

test("the registry exposes every module the approvals route dispatches on", () => {
  // A missing key means the approve button 500s for that module.
  for (const key of [
    "SKU", "RM_RATE", "PM_RATE", "RM_VRM", "PM_VRM", "RM_MAT", "PM_MAT",
    "VENDOR", "MFG", "PO", "BOM",
    "PO_BULK", "VENDOR_BULK", "MFG_BULK", "RM_BULK", "PM_BULK",
    "RM_VRM_BULK", "RM_RATE_BULK", "PM_VRM_BULK", "PM_RATE_BULK", "BOM_BULK",
  ]) {
    const handler = MODULE_HANDLERS[key]
    assert.ok(handler, `MODULE_HANDLERS is missing ${key}`)
    assert.equal(typeof handler.setStatus, "function", `${key}.setStatus`)
    assert.equal(typeof handler.applyAndArchive, "function", `${key}.applyAndArchive`)
  }
})

test("RM_RATE approval archives the OLD rate and writes the new one", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 120 })
    if (!rate) return t.skip("no raw materials in the test schema")

    const before = await readMrmHistory(conn, a.mfgId, rate.rm_id)

    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "155.50", remarks: "renegotiated" }), a.userId, a.userId
    )

    const live = await readRmMfgRate(conn, rate.id)
    assert.equal(num(live.curr_rate), 155.5, "the live row carries the approved value")
    assert.equal(live.status, "active", "an approved rate becomes active")

    const after = await readMrmHistory(conn, a.mfgId, rate.rm_id)
    assert.equal(after.length, before.length + 1, "exactly one archive row per approval")
    assert.equal(num(after[0].rate), 120, "the archived row holds the PRE-change rate")
    assert.equal(after[0].remarks, "renegotiated", "the submitter's reason is archived with it")
    assert.equal(after[0].changed_by, a.userId, "attributed to the submitter, not the approver")
  })
})

test("RM_RATE leaves fields absent from the diff at their current values", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 90, effective_from: "2026-02-01" })
    if (!rate) return t.skip("no raw materials")

    const original = await readRmMfgRate(conn, rate.id)

    // Only curr_rate is in the diff — uom and effective_from must survive.
    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "95" }), a.userId, a.userId
    )

    const live = await readRmMfgRate(conn, rate.id)
    assert.equal(num(live.curr_rate), 95)
    assert.equal(live.uom, original.uom, "uom must not be nulled by its absence")
    assert.equal(
      ymd(live.effective_from), ymd(original.effective_from),
      "effective_from must not be nulled by its absence"
    )
  })
})

test("RM_RATE rounds an approved rate to two decimals", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 10 })
    if (!rate) return t.skip("no raw materials")

    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "12.3456" }), a.userId, a.userId
    )
    assert.equal(num((await readRmMfgRate(conn, rate.id)).curr_rate), 12.35)
  })
})

test("REGRESSION (audit #4): RM_RATE archives the date the old rate stopped applying", async (t) => {
  // Used to hardcode null, leaving every archived manufacturer rate open-ended.
  // The end date is the incoming rate's start date.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 200, effective_from: "2026-01-01" })
    if (!rate) return t.skip("no raw materials")

    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "210", effective_from: "2026-06-01" }), a.userId, a.userId
    )

    const [archived] = await readMrmHistory(conn, a.mfgId, rate.rm_id)
    assert.equal(num(archived.rate), 200, "precondition: the old rate was archived")
    assert.ok(archived.effective_to, "effective_to must be set")
    assert.equal(
      ymd(archived.effective_to), "2026-06-01",
      "the old rate applied until the new one took effect"
    )
  })
})

test("REGRESSION (audit #4): a rate-only change ends the archived row today", async (t) => {
  // No effective_from in the diff — only the value changed — so the switch happens
  // on approval and today is the correct end date.
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 300, effective_from: "2026-01-01" })
    if (!rate) return t.skip("no raw materials")

    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "320" }), a.userId, a.userId
    )

    const [archived] = await readMrmHistory(conn, a.mfgId, rate.rm_id)
    assert.equal(ymd(archived.effective_to), today())
  })
})

test("supersededOn: the incoming start date wins, otherwise today", () => {
  assert.equal(supersededOn("2026-06-01"), "2026-06-01")
  assert.equal(supersededOn("  2026-06-01  "), "2026-06-01", "trimmed")
  assert.equal(supersededOn(undefined), today())
  assert.equal(supersededOn(""), today(), "an empty diff value is not a date")
  assert.equal(supersededOn("   "), today())
})

test("an approval on a missing entity throws instead of silently doing nothing", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    await assert.rejects(
      () => MODULE_HANDLERS.RM_RATE.applyAndArchive(
        conn, 2_000_000_000, diff({ curr_rate: "1" }), a.userId, a.userId
      ),
      /not found/
    )
  })
})

test("setStatus moves a rate through the review states without touching the value", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("no anchors")
    const rate = await makeRmMfgRate(conn, a, { rate: 75 })
    if (!rate) return t.skip("no raw materials")

    for (const status of ["in_review", "rejected", "active"]) {
      await MODULE_HANDLERS.RM_RATE.setStatus(conn, rate.id, status)
      const live = await readRmMfgRate(conn, rate.id)
      assert.equal(live.status, status)
      assert.equal(num(live.curr_rate), 75, "locking a record must never change its value")
    }
  })
})

test("a rolled-back approval leaves the live row and the archive untouched", async (t) => {
  // Proves the transaction boundary the approve route relies on: if anything
  // after applyAndArchive fails, the whole apply disappears.
  const a0 = await withRollback(async (conn) => anchors(conn))
  if (!a0) return t.skip("no anchors")

  let rateId = 0
  let rmId = 0

  // Inner rollback: apply the change, then abandon the transaction.
  await withRollback(async (conn) => {
    const rate = await makeRmMfgRate(conn, a0, { rate: 500 })
    if (!rate) return
    rateId = rate.id
    rmId = rate.rm_id
    await MODULE_HANDLERS.RM_RATE.applyAndArchive(
      conn, rate.id, diff({ curr_rate: "999" }), a0.userId, a0.userId
    )
    assert.equal(num((await readRmMfgRate(conn, rate.id)).curr_rate), 999, "applied inside the txn")
  })
  if (!rateId) return t.skip("no raw materials")

  // Fresh transaction: the fixture row itself was rolled back, so neither the
  // rate nor its archive row exists.
  await withRollback(async (conn) => {
    assert.equal(await readRmMfgRate(conn, rateId), undefined, "the rate row is gone")
    const history = await readMrmHistory(conn, a0.mfgId, rmId)
    assert.ok(
      !history.some(h => num(h.rate) === 500),
      "no archive row survived for the rolled-back rate"
    )
  })
})
