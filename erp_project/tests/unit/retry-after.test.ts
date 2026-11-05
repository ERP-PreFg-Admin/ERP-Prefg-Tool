import { test } from "node:test"
import assert from "node:assert/strict"
import { retryAfter } from "../../lib/uniware/retry-after"

class Refused extends Error {}
const isRefused = (e: unknown) => e instanceof Refused

test("retries a refusal after each delay until it succeeds", async () => {
  const slept: number[] = []
  const result = await retryAfter(
    async (n) => { if (n < 2) throw new Refused("not yet"); return "ok" },
    isRefused, [5, 15, 30], async (ms) => { slept.push(ms) })
  assert.equal(result, "ok")
  assert.deepEqual(slept, [5, 15])
})

test("gives up after the last delay with the last error", async () => {
  let tries = 0
  await assert.rejects(retryAfter(
    async () => { tries++; throw new Refused(`try ${tries}`) },
    isRefused, [1, 1], async () => {}), /try 3/)
  assert.equal(tries, 3)
})

test("any other error is not retried", async () => {
  let tries = 0
  await assert.rejects(retryAfter(
    async () => { tries++; throw new Error("session stale") },
    isRefused, [1, 1, 1], async () => {}), /session stale/)
  assert.equal(tries, 1)
})
