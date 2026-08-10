# API route testing

Three ways to exercise the object-level S3 key guard (`lib/s3-guard.ts`, audit
finding #5) end to end through the running app, plus the two findings still open.

`tests/db/` can't reach these routes: `withGateway` needs a real session and opens
its own transaction, so the rollback harness only reaches the helpers underneath
(see the constraint in `tests/helpers/db.ts`). Everything here is the layer above.

| | Needs | Good for |
|---|---|---|
| `npm run test:smoke` | dev server | **Start here.** All 12 checks, one command, pass/fail lines. |
| `erp-api.postman_collection.json` | Postman | Poking at one request, editing params by hand. |
| the curl block below | dev server | Same checks, no Node script, copy-paste. |

## `npm run test:smoke`

```bash
npm run dev                                       # in another terminal
npm run test:smoke
npm run test:smoke -- --as qa@mcaffeine.com       # act as a scoped user
npm run test:smoke -- --base http://localhost:3001
```

Mints its own session, so there is nothing to paste. Exits 0 while the only
failure is the known-open `/api/files/preview` check, non-zero the moment
anything else breaks — so it works as a pre-commit gate on these routes.

It leaves two real objects in S3 under `qa-probe/` (the non-overwrite check needs
two actual uploads) and prints their names at the end.

## Getting a session cookie

Every route except `/api/health` needs one. `proxy.ts`'s matcher excludes
`/api/*`, so the cookie is the whole of the auth check.

### A. From your browser

1. `npm run dev`, sign in at <http://localhost:3000> with Google as usual.
2. DevTools → **Application** → Cookies → `http://localhost:3000`.
3. Copy the **value** of `authjs.session-token` (long, three dot-separated
   segments). Behind HTTPS the cookie is `__Secure-authjs.session-token` — set
   the `cookieName` collection variable to match.
4. In Postman: collection → **Variables** → paste into `sessionToken` → Save.

The cookie is a JWT with a 30-day default, but signing out invalidates the
session row. A wave of 401s means re-copy it.

### B. Mint one — `mint-session.mjs`

```bash
node --env-file=.env tests/postman/mint-session.mjs                  # first active user
node --env-file=.env tests/postman/mint-session.mjs qa@mcaffeine.com # a specific one
node --env-file=.env tests/postman/mint-session.mjs --cookie         # ready for a curl -H
```

Same JWT the app issues on sign-in — NextAuth's own `encode()`, your
`AUTH_SECRET`, salted with the cookie name. No browser, no OAuth round trip, and
you can mint for *any* user, which is the only practical way to test the
out-of-scope 403 paths. It refuses to run with `APP_ENV=prod`.

It prints the user's roles and entity scope to stderr, so you can see at a glance
whether the token you're holding proves anything about scope:

```
user 1 <aadya.dewangan@mcaffeine.com>  roles: developer  scope: UNRESTRICTED (no user_entity_scope rows — sees everything)
```

> Either way the token authenticates as a real user. Don't commit it — the
> collection ships with `sessionToken` empty, keep it that way.

## Running it

Import the JSON, then run the folders **in order** — `0. Setup` harvests a real
PO attachment key and `1. Upload` harvests a key you own; the presign folder uses
both.

`1. Upload` needs you to click **Select Files** on the `file` form row and pick
`probe.csv` from this folder (any PDF / PNG / CSV under 10 MB works). Postman
won't interpolate a path there, which is also why this collection is UI-first
rather than a Newman job.

### In VS Code (`postman.postman-for-vscode`)

> **"Could not import collection. Please try again."** — the extension's import is
> opaque and fails for reasons it won't name. Things that have helped: sign in
> first (**Postman: Login**) and make sure a workspace is selected, since import
> targets a workspace rather than the file; and import from the Postman sidebar's
> Import button rather than the command palette. The JSON here has been flattened
> to the plainest v2.1 shape (string URLs, an `info._postman_id`) to give the
> importer as little to trip on as possible.
>
> It is not worth much fighting: `npm run test:smoke` runs the same checks with no
> account and no extension.

1. `Ctrl+Shift+P` → **Postman: Login** — the extension needs an account, it
   stores collections in a Postman workspace rather than reading the file.
2. `Ctrl+Shift+P` → **Postman: Import** → pick
   `tests/postman/erp-api.postman_collection.json`.
3. Postman icon in the Activity Bar → the collection → **Variables** → paste
   your token into `sessionToken` → Save.
4. Click requests top to bottom. Assertions land in the response pane's **Test
   Results** tab.

The extension has no collection runner, so it is 13 clicks in order rather than
one Run. If signing in isn't worth it, the curl block below does the same nine
checks in the integrated terminal.

Both upload requests write real objects to S3 under `postman/qa/`. Harmless, but
they are real — clean them up if the bucket matters.

## What each check proves

| Request | Proves |
|---|---|
| PO list | Your cookie works. A 401 here invalidates every result below it. |
| Upload probe | The key carries the `-u<id>-<12 hex>` marker `buildUploadKey` adds. |
| Upload again | Identical folder+field yield a different key — the `PutObject` overwrite is impossible. |
| Presign my own key | The marker lets you read a file you uploaded but haven't saved to a row yet — the Add Vendor / Add Manufacturer preview flow. |
| Presign an unowned key | **The enumeration fix.** Used to return a working URL for any key in the bucket. |
| Presign a forged marker | The marker covers your own uploads only; it is not a general bypass. |
| Presign a real PO attachment | The owner lookup still finds real documents. The regression that would hurt most. |
| Presign with no session | `withGateway` rejects before the guard is reached. |

## Verified 2026-08-05 against localhost:3000

Every check below was run headlessly (curl + a locally minted dev session for
user 1) before this collection was committed, so an unexpected result is a real
regression rather than a bad request.

| Check | Result |
|---|---|
| `GET /api/purchase-orders` with the session cookie | 200, 25 rows, 14 with an `attachment_key` |
| presign a real PO attachment (`invoices/2026-08/1167-e63a0bec.pdf`) | **200** — old, unmarked keys still resolve through their owning row |
| presign `postman/qa/no-such-object-9f3a1c.pdf` | **403 `forbidden`** — refused before S3 is touched |
| presign with no key | 400 `key is required` |
| upload `qa-probe/probe` twice | `probe-u1-ccf07eb82ceb.csv` then `probe-u1-3d119ee61c75.csv` — marker present, keys differ |
| presign my own just-uploaded key | **200** — the not-yet-saved preview flow still works |
| same key with the marker rewritten to `-u999999-` | **403** |
| presign with no cookie | 401 |
| **preview** the same unowned key presign refused | **500, not 403** — it went to S3 without authorizing anything (finding #5, still open) |

That last row is the clearest statement of where things stand: identical key,
`presign` refuses it at the guard, `preview` carries it all the way to S3.

Those two `qa-probe/` objects are real and still in the bucket — delete them if
it matters.

## Load testing — `npm run test:load`

`tests/load.mjs`. Closed-loop, no dependencies, mints its own session, GET only.

```bash
npm run build && npx next start -p 3100          # NOT npm run dev — see below
npm run test:load -- --base http://localhost:3100
npm run test:load -- --base http://localhost:3100 --conc 24 --dur 15
MSYS_NO_PATHCONV=1 npm run test:load -- --path /api/approvals --conc 8
```

Measured 2026-08-05, production build, 8 concurrent, 6s each:

| endpoint | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| `/api/health` (no DB) | 838 | 9ms | 15ms | 22ms |
| `/api/purchase-orders` | 167 | 46ms | 69ms | 81ms |
| `/api/files/presign` | 219 | 35ms | 48ms | 61ms |
| `/api/approvals` | **33** | **231ms** | 354ms | 732ms |

Two things that run came out with:

**The key guard is not a hot-path cost.** `selectKeyOwners` measures 7–9ms warm
against real data (25 POs, 250 approval_items, 107 vendor detail rows) — the same
as a single indexed lookup — and presign sustains 219 req/s. Worth re-checking if
those tables grow by orders of magnitude, since the `*_key` columns are `TEXT` and
so aren't indexed.

**`/api/approvals` is an N+1.** `app/api/approvals/route.ts` fires
`1 + 3 × pendingCount` queries per request — 43 today, at 14 pending. A ramp shows
the classic pool-bound shape: concurrency 1 → 8 → 24 moves throughput only
23 → 35 → 42 req/s while p50 goes 41ms → 220ms → **615ms**. Single-request latency
is fine; it's the `DB_POOL_SIZE`-10 pool being drained by one request at a time.
Fix direction: three batched queries (`WHERE approval_id IN (?)`) instead of three
per row. Not done here — this pass was scoped to testing.

### Deployed dev (`https://dev.erp.mcaffeine.com`), same profile

| endpoint | req/s | p50 | p95 | p99 | codes |
|---|---|---|---|---|---|
| `/api/health` | 407 | 17ms | 35ms | 53ms | `200:2442` |
| `/api/purchase-orders` | 100 | 46ms | 74ms | **60.0s** | `200:593` **`504:8`** |
| `/api/approvals` | 24 | 106ms | **60.0s** | 60.0s | `200:139` **`504:8`** |
| `/api/files/presign` | 154 | 42ms | 88ms | 297ms | `200:923` |

Roughly half the local throughput, which is just network RTT to AWS — `/api/health`
going 9ms → 17ms sets that baseline, and the rest is the same shape on top of it.
`presign` is clean over the wire too: 154 req/s, no timeouts.

**The finding is the `504:8`.** Eight is the concurrency, so *every in-flight
request stalled simultaneously* and sat there until something cut them at exactly
60s — the ALB idle timeout. Then it recovered: 593 requests after it succeeded
normally. That is a stall, not a slow endpoint, and it hit the two DB-heavy routes
while `presign` and `health` in the same run were untouched.

The mechanism to check first: `lib/db.ts` builds the pool with
`waitForConnections: true, queueLimit: 0` — an unlimited queue with **no
acquisition timeout**. If the pool's connections die at once (the same transient
RDS `ETIMEDOUT` that interrupted this work twice locally — audit #7), every
request waiting for a connection waits forever, until the load balancer gives up
at 60s. A finite `queueLimit` would fail those requests in milliseconds with a
clear error instead of converting a two-second blip into a minute of hung
requests. Correlate against CloudWatch for `ETIMEDOUT` / `ECONNRESET` at the run's
timestamp before treating it as anything else.

### Don't load test `npm run dev`

Dev mode compiles on demand and skips every production optimisation. The same
presign endpoint measured **1525ms p50 / 6 req/s** in dev and **35ms / 219 req/s**
on a build — a 40× difference that would have sent you optimising a query that was
never slow.

## Building it by hand in Postman

If the importer won't cooperate, six requests cover everything that matters.
`Ctrl+Shift+P` → **Postman: Create a new Postman collection**, then **Create a new
HTTP Request** for each row below.

**Once, on the collection:** Variables tab → add `token`, pasted straight from the
clipboard:

```bash
node --env-file=.env tests/postman/mint-session.mjs | clip
```

Copy it out of the terminal by hand and you will probably get
`Error: Invalid character in header content ["Cookie"]` — the JWT wraps across
several terminal lines and the selection takes the line breaks with it. The pipe
avoids that (the info line goes to stderr, only the token is piped).

Then the Pre-request Script tab:

```js
// The replace() is not decoration: a token pasted from a wrapped terminal line
// carries newlines, and a header value containing one is rejected outright.
const token = (pm.collectionVariables.get('token') || '').replace(/\s+/g, '')
pm.request.headers.upsert({ key: 'Cookie', value: 'authjs.session-token=' + token })
```

That authenticates every request in the collection. (If the extension doesn't run
collection scripts, drop the script and instead add a `Cookie` header of
`authjs.session-token=<token>` to each request — same effect, more typing, same
newline trap.)

| # | Request | Want | What it proves |
|---|---|---|---|
| 1 | `GET localhost:3000/api/purchase-orders` | **200** | Your token works. Copy any non-null `attachment_key` from the response for #2. A 401 means re-mint. |
| 2 | `GET .../api/files/presign?key=<that key>` | **200** | The guard still lets real documents through — the regression that would hurt most. |
| 3 | `GET .../api/files/presign?key=qa-probe/no-such-object.pdf` | **403** | **The fix.** Any key at all used to return a working signed URL. |
| 4 | `POST .../api/upload` — Body → form-data: `file` (type File → pick `probe.csv`), `folder`=`qa-probe`, `field`=`probe` | **200** | Response `key` ends `-u<yourId>-<12 hex>.csv`. Send twice: the two keys differ, so an upload can't overwrite an existing object. |
| 5 | `GET .../api/files/presign?key=<key from #4>` | **200** | A file you just uploaded is readable before any row references it — the Add Vendor / Add Manufacturer preview flow. |
| 6 | Same as #5, but hand-edit `-u<yourId>-` to `-u999999-` | **403** | The marker covers your own uploads only; it isn't a general bypass. |

Then delete the collection-level script (or the `Cookie` header) and re-send #5:
**401**. And point #3's URL at `/api/files/preview` instead of `/api/files/presign`:
**500, not 403** — same key, and preview carries it to S3 without authorizing
anything. That is finding #5's remaining half, in one click.

## Without Postman

The whole suite is nine curl calls. Bash (Git Bash on Windows):

```bash
C="Cookie: $(node --env-file=.env tests/postman/mint-session.mjs --cookie)"
B=http://localhost:3000

# a document on a PO you can see — 200
curl -s -o /dev/null -w '%{http_code}\n' -H "$C" "$B/api/purchase-orders" # 200 first: is the cookie good?
KEY=$(curl -s -H "$C" "$B/api/purchase-orders" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.attachment_key).attachment_key))")
curl -s -o /dev/null -w 'own PO doc      %{http_code} (want 200)\n' -H "$C" "$B/api/files/presign?key=$KEY"

# a key owned by nothing — the enumeration fix
curl -s -o /dev/null -w 'unowned key     %{http_code} (want 403)\n' -H "$C" "$B/api/files/presign?key=nope/does-not-exist.pdf"

# no key, no session
curl -s -o /dev/null -w 'no key          %{http_code} (want 400)\n' -H "$C" "$B/api/files/presign"
curl -s -o /dev/null -w 'no session      %{http_code} (want 401)\n'       "$B/api/files/presign?key=$KEY"

# upload twice: marker present, keys never repeat
printf 'a,b\n1,2\n' > /tmp/probe.csv
for i in 1 2; do curl -s -H "$C" -F "file=@/tmp/probe.csv;type=text/csv" -F folder=qa-probe -F field=probe "$B/api/upload"; echo; done

# then presign the key you just got (want 200), and again with -u999999- in place
# of your own marker (want 403)
```

## Proving scope, not just ownership

The checks above prove *existence* authorization. To prove *scope* — that
manufacturer A's user can't read manufacturer B's document — you need a
restricted user, because an unrestricted one is allowed everywhere by design:

1. `/admin` → **Data Access** → give a test user exactly one manufacturer.
2. `node --env-file=.env tests/postman/mint-session.mjs thatuser@mcaffeine.com`
   — it will print `scope: mfg=1` instead of `UNRESTRICTED`. If it still says
   UNRESTRICTED the scoping didn't save, and every result below is meaningless.
3. Presign an `attachment_key` from a PO belonging to a *different*
   manufacturer: expect **403 `out_of_scope`** (a different code from the
   `forbidden` an unowned key returns — that distinction tells you which of the
   two rules refused you).

Same procedure turns the invoice request in folder 3 into a real test for
finding #6: as that user, `GET /api/purchase-orders/invoice/<id>` for another
manufacturer's invoice still returns **200** today, header and line items
included. That is the defect.

## Folder 3 is red on purpose

Those two requests assert the behaviour we *want* for findings that aren't fixed
yet, so they flip green when the fix lands instead of relying on someone
remembering. `/api/files/preview` is two lines from fixed: `assertKeyReadable`,
and delete the `..` check.
