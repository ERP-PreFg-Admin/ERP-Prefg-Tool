// Uniware has exactly ONE live access token per user, tenant-wide. Proved
// against prod on 2026-09-08:
//
//     password grant       -> Ta    Ta -> 200
//     refresh grant        -> Tb    Tb -> 200,  Ta -> 401
//     password grant again -> Tb    (same token, expires_in counting down)
//
// The prod and test containers both run as erp.prefg@mcaffeine.com, so the test
// container's refresh evicted prod's cached token and every PO on the invoices
// tab answered "Not authorised — check the Uniware credentials, and that the
// record's facility matches the one being asked." for hours.
//
// Both halves of the fix are pinned here: never refresh, and never trust a
// cached token for its full 12 hours.
//
// Env before the import: lib/env.ts reads process.env at module load.
process.env.UNIWARE_BASE_URL = "https://uniware.test"
process.env.UNIWARE_USER_NAME = "test-user"
process.env.UNIWARE_PASSWORD = "test-pass"

import { test } from "node:test"
import assert from "node:assert/strict"

type Call = { url: string; method: string }

/**
 * A fresh copy of lib/uniware/auth with its token cache cold, plus a stub fetch
 * recording every /oauth/token call.
 *
 * The `?v=` is load-bearing: the cache is module-level state, so without it the
 * second test in this file inherits the first one's warm token and every
 * assertion about re-minting silently passes on zero calls.
 */
let seq = 0
async function freshAuth(expiresIn: number, tokens: string[]) {
  const calls: Call[] = []
  let n = 0
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" })
    return Response.json({
      access_token: tokens[Math.min(n++, tokens.length - 1)],
      refresh_token: "refresh-1",
      expires_in: expiresIn,
    })
  }) as unknown as typeof fetch

  const mod = await import(`../../lib/uniware/auth?v=${++seq}`) as
    typeof import("../../lib/uniware/auth")
  return { getToken: mod.getToken, calls }
}

test("the first token comes from the password grant, as a POST", async () => {
  const { getToken, calls } = await freshAuth(43199, ["tok-a"])

  const t = await getToken()

  assert.equal(t.accessToken, "tok-a")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /grant_type=password/)
  assert.equal(calls[0].method, "POST")
})

test("a cached token is reused rather than re-minted", async () => {
  const { getToken, calls } = await freshAuth(43199, ["tok-b1", "tok-b2"])

  const first = await getToken()
  const second = await getToken()
  const third = await getToken()

  assert.equal(calls.length, 1, `expected one mint, got ${calls.length}`)
  assert.equal(first.accessToken, "tok-b1")
  assert.equal(second.accessToken, "tok-b1")
  assert.equal(third.accessToken, "tok-b1")
})

test("a 12-hour token is NOT cached for 12 hours", async () => {
  // The blackout: expires_in says 43199s, but the token can be evicted at any
  // moment by anything else on the account, with nothing telling us. Capping the
  // cache is what bounds the outage to minutes instead of half a day.
  const { getToken } = await freshAuth(43199, ["tok-c"])

  const t = await getToken()
  const heldFor = t.expiresAt - Date.now()

  assert.ok(heldFor <= 5 * 60_000, `cached for ${Math.round(heldFor / 1000)}s — expected 5 min or less`)
  assert.ok(heldFor > 0, "a token cached for zero time would re-mint on every call")
})

test("an already-dying token is not clamped up to the cap", async () => {
  // 120s minus the 300s safety buffer is negative. It must stay negative — a
  // token inside its own buffer has to be re-read, not trusted for five minutes.
  const { getToken } = await freshAuth(120, ["tok-d"])

  const t = await getToken()

  assert.ok(t.expiresAt - Date.now() <= 0, `expected an expired window, got ${t.expiresAt - Date.now()}ms`)
})

test("the refresh grant is never used", async () => {
  // The one that caused the outage. Anything minting a genuinely new token
  // invalidates every other holder's; the password grant hands back the same one.
  // expires_in 120 is inside the buffer, so every call is a cache miss and would
  // have taken the refresh path when there was one.
  const { getToken, calls } = await freshAuth(120, ["tok-e", "tok-f", "tok-g"])

  await getToken()
  await getToken()
  await getToken()

  assert.equal(calls.length, 3, `expected a mint per call, got ${calls.length}`)
  for (const c of calls) {
    assert.ok(!c.url.includes("refresh_token"), `refresh grant used: ${c.url}`)
    assert.match(c.url, /grant_type=password/)
    assert.equal(c.method, "POST")
  }
})

test("the token object carries no refresh token to tempt anyone", async () => {
  const { getToken } = await freshAuth(43199, ["tok-h"])

  const t = await getToken()

  assert.equal("refreshToken" in t, false, "a stored refresh token is how the refresh path comes back")
})
