import { __resetRateLimitState, acquire } from "@/lib/gateway/rate-limit"
import { test , beforeEach } from "node:test"
import assert from "node:assert/strict"

const PATH = "/api/v2/purchase-orders/invoice/parse"
const USER = 2
const sleep = (ms : number) => new Promise((r) => setTimeout(r , ms))

beforeEach(() => {
    process.env.RATE_LIMIT_MODE = "enforce"
    __resetRateLimitState()
})

test("allows up to the limit, then refuses" , () => {
    const rule = { limit :3 , windowMs : 60_000}
    for(let i = 0 ; i < 3 ; i++) {
        assert.equal(acquire(PATH , USER , rule).ok , true , `call ${i+1} should pass`)
    }
    const denied = acquire(PATH ,USER , rule)
    assert.equal(denied.ok , false)
    assert.equal(denied.ok === false && denied.reason , "rate")
    assert.ok(denied.ok === false && denied.retryAfterSec >= 1, "must say when to retry")

})


test("a refused call does not count as a hit , so it cannot extend its own lockout" , async () => {
    const rule = {limit : 1 , windowMs: 80}
    assert.equal(acquire(PATH , USER , rule).ok , true)
    for( let i = 0 ; i < 3 ; i++) {
        assert.equal(acquire(PATH , USER , rule).ok ,false)
    }
    await sleep(100)
    assert.equal(acquire(PATH , USER, rule).ok , true, "window must clear despite of refusals")

})

test("the window slides", async () => {
  const rule = { limit: 1, windowMs: 80 }
  assert.equal(acquire(PATH, USER, rule).ok, true)
  assert.equal(acquire(PATH, USER, rule).ok, false)
  await sleep(100)
  assert.equal(acquire(PATH, USER, rule).ok, true)
})

test("per-user concurrency refuses the extra tab and recovers on release", () => {
  const rule = { limit: 100, windowMs: 60_000, concurrency: 2 }
  const a = acquire(PATH, USER, rule)
  const b = acquire(PATH, USER, rule)
  assert.ok(a.ok && b.ok)

  const c = acquire(PATH, USER, rule)
  assert.equal(c.ok, false)
  assert.equal(c.ok === false && c.reason, "concurrency")

  if (a.ok) a.release()
  assert.equal(acquire(PATH, USER, rule).ok, true, "a freed slot must be reusable")
})

test("instance concurrency spans users", () => {
  const rule = { limit: 100, windowMs: 60_000, instanceConcurrency: 2 }
  assert.ok(acquire(PATH, 1, rule).ok)
  assert.ok(acquire(PATH, 2, rule).ok)
  const third = acquire(PATH, 3, rule)
  assert.equal(third.ok, false, "a third user must hit the instance-wide gate")
})

test("release is idempotent — a double call cannot mint a slot", () => {
  const rule = { limit: 100, windowMs: 60_000, concurrency: 1 }
  const a = acquire(PATH, USER, rule)
  assert.ok(a.ok)
  if (a.ok) { a.release(); a.release() }

  const b = acquire(PATH, USER, rule)
  assert.ok(b.ok)
  assert.equal(acquire(PATH, USER, rule).ok, false, "only ONE slot should have been freed")
})

test("shadow mode never refuses, but reports what it would have done", () => {
  process.env.RATE_LIMIT_MODE = "shadow"
  const rule = { limit: 1, windowMs: 60_000 }
  assert.ok(acquire(PATH, USER, rule).ok)

  const over = acquire(PATH, USER, rule)
  assert.equal(over.ok, true, "shadow mode must let it through")
  assert.equal(over.ok === true && over.wouldBlock?.reason, "rate")
  assert.equal(over.ok === true && over.wouldBlock?.limit, 1)
})

test("shadow mode is the default when RATE_LIMIT_MODE is unset", () => {
  delete process.env.RATE_LIMIT_MODE
  const rule = { limit: 1, windowMs: 60_000 }
  assert.ok(acquire(PATH, USER, rule).ok)
  assert.equal(acquire(PATH, USER, rule).ok, true, "unset must not enforce")
})

