# API Hardening Plan

**Status:** proposal — nothing here is implemented. Written 2026-08-12.
**Scope:** the 70 route files under `app/api/`. Auth, authorization, abuse
resistance, transport headers, and the two efficiency items that fall out of the
same audit.

**Companion docs:** `docs/architecture-evolution.md` §4 (the `withGateway`
design — its rate-limit and `middleware.ts` sections were never built; this plan
supersedes them), `docs/qa-audit-2026-08.md` §Security (finding #5, one item
still open).

---

## 1. Method

Every claim below was checked against the tree, not inferred:

- all 70 `route.ts` files enumerated; `withGateway` / `access:` / `schema:` /
  `assertInScope` coverage counted per file
- `lib/gateway/with-gateway.ts`, `lib/gateway/errors.ts`, `lib/permissions.ts`,
  `lib/auth.ts`, `auth.config.ts`, `next.config.ts` read in full
- SQL surface grepped for interpolation and user-controlled `ORDER BY`
- `package.json` deps and scripts reviewed

## 2. What is already right

Worth stating, because it narrows the work and stops a re-audit from re-finding it:

| Area | State |
|---|---|
| Gateway coverage | 68 of 70 routes go through `withGateway`. The two that don't are `/api/auth/[...nextauth]` (NextAuth's own handler) and `/api/health` (returns a bare `{status:"ok"}`, leaks nothing) |
| SQL injection | Not a live surface. Every query in `lib/queries/*.ts` is parameterised; the `${}` interpolations are constant column lists and `SQL_TODAY_IST`, never user input. User-controlled sort goes through the `SAFE_SORT_COLS` whitelist in `lib/queries/purchase-orders.ts:253` |
| Error leakage | `toErrorResponse` collapses every non-`ApiError` to `{error:"Database error", code:"internal", requestId}`. No stack traces, no driver messages |
| CSRF | Session is a NextAuth cookie with the default `SameSite=Lax`, which blocks cross-site `POST`. No token scheme needed |
| CORS | No `Access-Control-Allow-Origin` is ever set, so the browser enforces same-origin. Correct by omission — do not "fix" it |
| Upload validation | `/api/v1/upload` enforces a MIME allowlist and a 10 MB cap; keys are server-derived with a random token (`lib/s3-guard.ts`), so `PutObject` can't overwrite |
| Audit trail | Every non-GET writes an `activity_log` row with user, path, status, duration, IP, UA and request id |

## 3. Findings, ranked

Severity is exploitability × blast radius. Effort is my estimate of the diff.

| # | Finding | Severity | Effort |
|---|---|---|---|
| 1 | Deactivating a user, or revoking their role, does not end their API access | **Critical** | S |
| 2 | No rate limiting anywhere — including a metered third-party call and 16 full-table exports | **High** | S |
| 3 | `/api/v1/files/preview` still allows S3 key enumeration | **High** | XS |
| 4 | No security response headers (no HSTS, CSP, nosniff, frame-ancestors) | Medium | XS |
| 5 | Pagination `limit` is unbounded on 33 of 34 routes that read one | Medium | M |
| 6 | `trustHost: true` with no `AUTH_URL` now that Amplify is gone | Low | XS |
| 7 | `lib/auth.ts` `console.log`s user emails outside the logger | Low | XS |
| 8 | `resolveAccess` costs up to 2 queries per slug level, per request | — (perf) | S |
| 9 | 26 routes still return ad-hoc error JSON instead of throwing `ApiError` | — (consistency) | M |

---

## 4. Finding 1 — session state never re-checks the database

**Severity: Critical.** This is the one to fix first.

**Where:** `lib/gateway/with-gateway.ts:59-68`, `lib/auth.ts:14-40`, `auth.config.ts:26`

**What happens.** `withGateway` calls `auth()`, which decodes the session JWT and
returns it. Nothing on that path reads the `users` table. Two consequences:

- `lib/auth.ts`'s `signIn` callback is the only place `status === "inactive"` is
  checked, and it runs **once, at login**. Deactivating a user in
  `/admin > Users` does not log them out — their existing token keeps working.
- `session.user.roles` is baked into the token at login and passed straight into
  `resolveAccess(userId, roles, slug)`. Adding or removing a role has no effect
  until that user signs in again.

`session: { strategy: "jwt" }` in `auth.config.ts:26` sets no `maxAge`, so the
token lives for NextAuth's default **30 days**. An offboarded employee keeps
full API access for up to a month.

Per-user overrides in `user_page_permissions` *are* re-read per request (they're
keyed on `userId`), so a targeted permission revoke does land immediately. Role
membership and account status do not. That partial correctness is why this hasn't
been noticed.

**Fix.** One freshness check in `withGateway`, because that's the single point
all 68 routes route through — a fix in `lib/auth.ts`'s callbacks would depend on
NextAuth's token-refresh timing, and a fix per route is 68 diffs.

New query in `lib/queries/auth.ts`:

```ts
  /** Params: [user_id] — live status + roles, for the per-request freshness check. */
  getLiveIdentity: `
    SELECT u.status, GROUP_CONCAT(ur.role) AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    WHERE u.id = ?
    GROUP BY u.id
  `,
```

New file `lib/gateway/identity.ts`:

```ts
import { query } from "@/lib/db"
import { auth as authSql } from "@/lib/queries/auth"

type Live = { status: string | null; roles: string[] }
// ponytail: per-process Map, correct on one EC2 instance. Move to Redis at the
// same time as the rate limiter if the app ever runs on more than one.
const cache = new Map<number, { at: number; live: Live }>()
const TTL_MS = 60_000

export async function liveIdentity(userId: number): Promise<Live> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.live

  const rows = await query<{ status: string | null; roles: string | null }>(
    authSql.getLiveIdentity, [userId]
  )
  const live: Live = {
    status: rows[0]?.status ?? null,
    roles: rows[0]?.roles?.split(",").filter(Boolean) ?? [],
  }
  cache.set(userId, { at: Date.now(), live })
  return live
}

/** Call after any write to users / user_roles so the change lands immediately. */
export function forgetIdentity(userId: number) {
  cache.delete(userId)
}
```

Then in `lib/gateway/with-gateway.ts`, replace lines 61-65:

```ts
      ctx.userId = Number(session.user.id)

      const live = await liveIdentity(ctx.userId)
      if (!rows0(live)) throw new ApiError(401, "unauthorized", "Unauthorized")
      if (live.status === "inactive") throw new ApiError(401, "account_disabled", "Account is disabled")

      if (opts.access) {
        const level = await resolveAccess(ctx.userId, live.roles, opts.access.pageSlug)
```

(`rows0` above is shorthand — treat "user id not found in `users`" as 401 too;
a deleted user with a valid token must not pass.)

And call `forgetIdentity(id)` from `app/api/v1/admin/users/route.ts` (PATCH) and
`app/api/v1/admin/permissions/route.ts` after their writes, so an admin's action
takes effect now rather than within 60 s.

Also set a token lifetime in `auth.config.ts:26`, so a stolen token expires:

```ts
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
```

**Cost:** one extra query per user per minute, not per request.

**Verify:** `tests/unit/gateway-identity.test.ts` (`node:test`) — cache returns
the stored value inside the TTL, re-queries after it, `forgetIdentity` forces a
re-read. Then manually: deactivate yourself in a second browser profile and
confirm the next API call 401s within a minute.

---

## 5. Finding 2 — no rate limiting

**Severity: High.** Nothing in the codebase limits request rate. `lib/gateway/`
contains only `errors.ts` and `with-gateway.ts`; the `rate-limit.ts` promised in
`architecture-evolution.md:208` was never written, and there is no
`middleware.ts` in the tree at all.

The endpoints where this actually costs something:

| Endpoint | Why it matters |
|---|---|
| `POST /api/v2/purchase-orders/invoice/parse` | Falls through to **Nanonets, which is metered**. `maxDuration = 300`, 50-70 s per call. A loop here is a billing incident, not just load |
| `POST /api/v1/purchase-orders/invoice/parse` | v1, same metered path, always Nanonets |
| 16 `*/export/route.ts` | Each dumps a full filtered table through ExcelJS in memory |
| `POST /api/v1/purchase-orders/send-mail` | Sends real mail via `nodemailer` to vendor/warehouse addresses |
| `POST /api/v1/upload` | 10 MB per call, unbounded call count |

Every one requires a session, so this is abuse-by-authenticated-user or a stolen
token, not anonymous flooding — which is exactly why it pairs with finding 1.

**Fix.** In-memory token bucket, opt-in per route, no dependency.

New file `lib/gateway/rate-limit.ts`:

```ts
// ponytail: per-process counters — correct on a single EC2 instance, which is
// what deploy/setup-commands.md provisions. Swap the Map for Redis if the app
// is ever scaled out; the signature stays.
const hits = new Map<string, number[]>()

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) { hits.set(key, recent); return false }
  recent.push(now)
  hits.set(key, recent)
  return true
}
```

In `with-gateway.ts`, add `rateLimit?: { limit: number; windowMs: number }` to
the opts type and check it right after the access check:

```ts
      if (opts.rateLimit) {
        const key = `${ctx.path}:${ctx.userId}`
        const { limit, windowMs } = opts.rateLimit
        if (!checkRateLimit(key, limit, windowMs)) {
          throw new ApiError(429, "rate_limited", "Too many requests, try again shortly")
        }
      }
```

Then declare it on the endpoints in the table above — suggested starting values,
tune from `activity_log`:

| Route | `rateLimit` |
|---|---|
| both `invoice/parse` | `{ limit: 20, windowMs: 60_000 }` |
| `send-mail` | `{ limit: 30, windowMs: 60_000 }` |
| every `*/export` | `{ limit: 10, windowMs: 60_000 }` |
| `upload` | `{ limit: 60, windowMs: 60_000 }` |

Leave it off ordinary list/CRUD routes — a limiter there only produces false
positives during normal table paging.

Because keys accumulate, prune inside `checkRateLimit` (the `.filter` already
does, per key) and accept the Map growing to one entry per (route, user) pair —
bounded by the user count, so no eviction logic is needed.

**Verify:** `tests/unit/rate-limit.test.ts` — the (limit+1)-th call in a window
returns false; a call after `windowMs` returns true. Then
`npm run test:load` against a limited endpoint and confirm 429s appear.

---

## 6. Finding 3 — `/api/v1/files/preview` key enumeration

**Severity: High. Already diagnosed and left open** in
`docs/qa-audit-2026-08.md:119` — "the fix is now two lines... left out only
because this pass was scoped to presign."

Any signed-in user can pass any S3 key and get the parsed contents of any
CSV/XLSX in the bucket back as JSON, across manufacturer and entity scope.

**Fix**, in `app/api/v1/files/preview/route.ts`:

```ts
import { assertKeyReadable } from "@/lib/s3-guard"
// ...inside the handler, before reading the object:
await assertKeyReadable(Number(session.user.id), key)
```

and delete the `key.includes("..")` check, which cannot catch anything on an S3
key. This is the same guard `presign` already uses; no new code.

**Verify:** covered by the existing `tests/db/s3-key-owners.test.ts`. Add a
manual check: request another manufacturer's `csv_source_key` and expect 403.

---

## 7. Finding 4 — no security response headers

**Severity: Medium.** `next.config.ts` declares only `output` and
`serverExternalPackages`. No `headers()`, so the app ships no HSTS, no
`X-Content-Type-Options`, no framing policy, no referrer policy.

**Fix** — native Next config, no `helmet`, no middleware:

```ts
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [/* unchanged */],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }]
  },
}
```

**CSP is deliberately not in that list.** Next's App Router injects inline
scripts, so a real CSP needs the nonce plumbing and will break the app if bolted
on blind. Treat it as its own task after the above ships, or skip it — the five
headers here are where the cheap wins are.

**Verify:** `curl -sI https://<host>/ | grep -i strict-transport` after deploy.

---

## 8. Finding 5 — unbounded pagination

**Severity: Medium.** 34 route files read `searchParams`; exactly one
(`app/api/v1/purchase-orders/invoice/route.ts:47`) clamps its `limit`. Everywhere
else `?limit=9999999` reaches `LIMIT ?` unchanged — a single request that pulls
an entire table into Node memory and serialises it to JSON. The 16 export routes
have no limit concept at all.

`withGateway` validates the body (`schema`) and route params (`paramsSchema`) but
has no query-string equivalent, which is why nobody validates query input.

**Fix** — add the missing third slot, mirroring the two that exist. In
`with-gateway.ts`:

```ts
  querySchema?: z.ZodType<TQuery>
  // ...alongside the paramsSchema block:
      let queryData = {} as TQuery
      if (opts.querySchema) {
        const parsed = opts.querySchema.safeParse(
          Object.fromEntries(req.nextUrl.searchParams)
        )
        if (!parsed.success) {
          throw new ApiError(400, "validation_error", "Invalid query parameters", parsed.error.flatten())
        }
        queryData = parsed.data
      }
```

and pass `query: queryData` into the handler args. Then one shared schema to
reuse — put it next to the existing route schemas:

```ts
export const pagingSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
```

Roll out in order of damage: the 16 `*/export` routes first, then the paginated
list routes, then the rest. Each adoption is `querySchema: pagingSchema.extend({...})`
plus swapping the hand-rolled `sp.get("limit")` line for `query.limit`.

**Skipped:** validating every remaining query param in one pass. The cap is what
stops the resource exhaustion; the rest is tidying and can ride along as each
route is next touched.

**Verify:** `tests/unit/paging-schema.test.ts` — `limit=9999` clamps to a 400,
`limit` absent defaults to 25, `limit=abc` 400s.

---

## 9. Findings 6-7 — two one-liners

**`trustHost: true`** (`auth.config.ts:41`) exists because Amplify fronted the
app behind rotating `*.amplifyapp.com` domains. Per
`project_ec2_docker_deploy`, the app now runs on a single EC2 instance with a
fixed Elastic IP, so the reason is gone and the setting lets a forged `Host`
header steer OAuth callback URLs. Set `AUTH_URL` in the SSM parameter set and
drop `trustHost`.

**`console.log("[AUTH] signIn attempt for email:", user.email)`**
(`lib/auth.ts:16,19`) writes user emails to stdout, which on EC2 means
CloudWatch, bypassing `lib/logger.ts` and its redaction. Delete both lines, or
route them through `logger.debug`.

---

## 10. Findings 8-9 — the "improve" half

Not security. Listed because the audit surfaced them and both are cheap.

**8. `resolveAccess` query count.** `lib/permissions.ts:39-56` loops slug →
parent → grandparent, issuing up to two queries per level. `/masters/vendors`
costs 4 round-trips before the handler starts; a deeper slug costs 6. One query
replaces the loop — build the slug chain in JS, then select both tables for all
of them at once and pick the most specific row:

```ts
const chain: string[] = []
for (let s: string | null = pageSlug; s; s = parentSlug(s)) chain.push(s)
// one SELECT ... WHERE page_slug IN (chain), ordered by CHAR_LENGTH(page_slug) DESC,
// user overrides ranked above role grants; take the first row.
```

Pairs naturally with finding 1 — both are per-request identity work and the
same 60 s cache can cover this if it's still hot after the rewrite.

**9. Error shape drift.** 26 route files still return
`NextResponse.json({ error: ... }, { status })` by hand, so those responses carry
no `code` and no `requestId` — the client can't branch on failure type and the
response can't be correlated to a log line. `/api/v1/upload` is a clear example
(three hand-rolled 400s and a 500). Convert to `throw new ApiError(...)` as each
route is next touched; not worth a dedicated sweep.

---

## 11. Sequencing

Three shipping units. Each is independently deployable and independently
revertable — do not batch them.

**Phase 1 — close the holes (do first).** Findings 1, 3, 6, 7.
Touches: `lib/gateway/identity.ts` (new), `lib/gateway/with-gateway.ts`,
`lib/queries/auth.ts`, `auth.config.ts`, `lib/auth.ts`,
`app/api/v1/files/preview/route.ts`, plus `forgetIdentity` calls in the two admin
routes. One new unit test file.

**Phase 2 — abuse resistance.** Findings 2 and 4.
Touches: `lib/gateway/rate-limit.ts` (new), `with-gateway.ts`, ~20 route files
adding one `rateLimit` line each, `next.config.ts`. One new unit test file.

**Phase 3 — input caps and cleanup.** Findings 5, 8, 9, rolled out
route-by-route rather than as a sweep.

## 12. Explicitly not in this plan

Each of these was considered and dropped; recorded so they don't get
re-proposed:

| Not doing | Why |
|---|---|
| Redis / Upstash for the limiter | Single EC2 instance. The in-memory Map is correct until that changes, and the `ponytail:` comment names the trigger |
| `helmet` or any headers package | `next.config.ts`'s `headers()` covers it in 8 lines |
| A CSRF token scheme | `SameSite=Lax` on the session cookie already blocks cross-site POST |
| AWS WAF / API Gateway in front | Infra spend and a second config surface for a single-instance internal ERP. Revisit if the app is ever exposed beyond the org |
| API keys / per-client secrets | There is exactly one client — this app's own frontend, on the same origin, already authenticated by session |
| A full CSP | Needs nonce plumbing through the App Router; breaks the app if guessed at. Its own task, later, or never |
| Rewriting all 70 routes for shape consistency | Finding 9 is drift, not risk. Fix on touch |
