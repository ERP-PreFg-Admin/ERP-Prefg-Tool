// Logs > By user aggregates: the real SQL on uncommitted rows, folded by summarizeUsers.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { withRollback, closePool, anchors } from "../helpers/db"
import { observabilityUsersSql } from "../../lib/queries/observability-users"
import { summarizeUsers, type UserRouteRow, type UserSessionRow } from "../../lib/services/user-activity"

after(closePool)

// A window in the future, so no real activity_log row can fall inside it.
const FROM = "2099-01-01 00:00:00"
const TO = "2099-01-02 00:00:00"

test("two calls for one user fold into one row with errors, slowest and modules", async (t) => {
  await withRollback(async (conn) => {
    const a = await anchors(conn)
    if (!a) return t.skip("schema has no users to anchor on")
    const insert = `INSERT INTO activity_log (user_id, method, path, status, duration_ms, request_id, created_on)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`
    await conn.query(insert, [a.userId, "POST", "/api/v1/purchase-orders/123/split", 200, 300, "rid-1", "2099-01-01 10:00:00"])
    await conn.query(insert, [a.userId, "PATCH", "/api/v1/masters/skus", 503, 4200, "rid-2", "2099-01-01 11:00:00"])

    const [routes] = await conn.query(observabilityUsersSql.userRouteStats, [FROM, TO, null, null])
    const [sessions] = await conn.query(observabilityUsersSql.userSessions, [FROM, TO, a.userId, a.userId])
    const rows = summarizeUsers(routes as UserRouteRow[], sessions as UserSessionRow[])

    assert.equal(rows.length, 1)
    const u = rows[0]
    assert.equal(u.user_id, a.userId)
    assert.equal(u.calls, 2)
    assert.equal(u.err_4xx, 0)
    assert.equal(u.err_5xx, 1)
    assert.equal(u.err_rate, 50)
    assert.equal(u.max_ms, 4200)
    assert.deepEqual(u.modules, ["purchase-orders", "masters"])
    assert.equal(u.last_seen?.toISOString(), "2099-01-01T11:00:00.000Z")

    const [tl] = await conn.query(observabilityUsersSql.userTimeline, [a.userId, FROM, TO, 1, a.userId, FROM, TO, 1, 10])
    assert.deepEqual((tl as { request_id: string }[]).map((r) => r.request_id), ["rid-2"])
  })
})
