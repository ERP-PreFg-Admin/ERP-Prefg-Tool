// Log lines inherit their request's id, user and module, and never a neighbour's.
import { test } from "node:test"
import assert from "node:assert/strict"
import { runWithLogContext, currentLogContext, stampLogFields } from "../../lib/observability/log-context"

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("overlapping requests keep their own context", async () => {
  const seen: Record<string, unknown>[] = []
  const request = (id: string, path: string, userId: number, delay: number) => {
    const ctx = { requestId: id, userId: null as number | null, path }
    return runWithLogContext(ctx, async () => {
      await tick(delay)
      ctx.userId = userId // set after "auth", like withGateway
      await tick(delay)
      seen.push(stampLogFields({ message: "inside" }))
    })
  }
  await Promise.all([request("a", "/api/v1/masters/skus", 1, 15), request("b", "/api/v1/purchase-orders/9", 2, 5)])
  const a = seen.find((s) => s.requestId === "a")!
  const b = seen.find((s) => s.requestId === "b")!
  assert.deepEqual([a.userId, a.path, a.module], [1, "/api/v1/masters/skus", "masters"])
  assert.deepEqual([b.userId, b.path, b.module], [2, "/api/v1/purchase-orders/9", "purchase-orders"])
  assert.equal(currentLogContext(), undefined)
})

test("a line outside any request gets nothing added", () => {
  const line = stampLogFields({ message: "boot" })
  assert.deepEqual(line, { message: "boot" })
})

test("a legacy module moves to code; path decides the module when present", () => {
  const ctx = { requestId: "r", userId: 7, path: "/api/v1/manufacturing/lines" }
  runWithLogContext(ctx, () => {
    const line = stampLogFields({ module: "MFG_LINE_CREATE", message: "x" })
    assert.equal(line.code, "MFG_LINE_CREATE")
    assert.equal(line.module, "manufacturing")
    assert.equal(line.userId, 7)
  })
  // No context (cron): module comes from the code.
  const cron = stampLogFields({ module: "CRON", message: "run" })
  assert.deepEqual([cron.code, cron.module], ["CRON", "jobs"])
  // An existing error code is kept, not overwritten.
  const err = stampLogFields({ module: "PM_MAT", code: "ER_DUP_ENTRY", message: "x" })
  assert.deepEqual([err.code, err.errorCode, err.module], ["PM_MAT", "ER_DUP_ENTRY", "masters"])
})

test("a line's own path is kept, but the request's id wins and the line's id moves to opId", () => {
  runWithLogContext({ requestId: "ctx", userId: 1, path: "/api/v1/admin/users" }, () => {
    const line = stampLogFields({ requestId: "own", path: "/api/v1/uniware/session", message: "x" })
    assert.deepEqual(
      [line.requestId, line.opId, line.path, line.module],
      ["ctx", "own", "/api/v1/uniware/session", "uniware"]
    )
  })
})

test("a string userId becomes the request's numeric one, or a number outside a request", () => {
  runWithLogContext({ requestId: "r", userId: 7, path: "/api/v1/masters/skus" }, () => {
    assert.equal(stampLogFields({ userId: "7", message: "x" }).userId, 7)
  })
  assert.equal(stampLogFields({ userId: "12", message: "x" }).userId, 12)
})

test("the logger stamps at call time", async () => {
  const { default: logger } = await import("../../lib/logger")
  const seen: Record<string, unknown>[] = []
  const original = logger.transports
  const sink = new (await import("winston-transport")).default({
    log(info: Record<string, unknown>, next: () => void) { seen.push(info); next() },
  } as never)
  logger.clear().add(sink)
  try {
    runWithLogContext({ requestId: "req-1", userId: 3, path: "/api/v1/approvals" }, () =>
      logger.info({ module: "GET_APPROVALS", message: "hi" })
    )
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(
      [seen[0]?.requestId, seen[0]?.userId, seen[0]?.module, seen[0]?.code],
      ["req-1", 3, "approvals", "GET_APPROVALS"]
    )
  } finally {
    logger.clear()
    for (const t of original) logger.add(t)
  }
})
