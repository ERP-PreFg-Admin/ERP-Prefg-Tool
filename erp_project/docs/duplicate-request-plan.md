# Duplicate Requests on Repeated Clicks — Plan

> **Related docs:** [API Conventions](./api/00-conventions.md) · [API Information Flow](./api-information-flow.md) · [Frontend Patterns](./frontend-patterns.md)

## Context

Clicking a tab, a button or a section header more than once fires the request more
than once. Three separate causes share that symptom, and they are not equally
serious.

**1. Tabs re-navigate to the URL they are already on.** `TabBar.tsx:38` calls
`router.push()` unconditionally. Line 37 directly above already computes
`active={currentTab === tab.key}` — for styling. Nine pages set
`export const dynamic = "force-dynamic"`, so re-pushing the current URL re-runs the
whole server component: on Agreed Final Costing that is **eight queries per click**.

**2. Nothing cancels a superseded request.** `AbortController` appears in exactly
**one** of ~60 fetching client components (`GatepassClient`). Everywhere else the
first request still lands, and when responses return out of order the older one
overwrites the newer.

> `RateHistoryDialog` fetches in a `useEffect` keyed on `row`. Open row A, then
> quickly row B: B resolves, then A resolves and overwrites it. The dialog now shows
> row B's heading over row A's history. Its own comment shows the author knew —
> *"clears stale results before the new row's fetch resolves"* — but clearing the
> display does not stop the stale response arriving.

**This one is a wrong-data bug, not a load problem**, and it is the reason to do this
work at all.

**3. Every component invents its own guard.** There is no `lib/hooks/`, no shared
fetch helper, and the shared `Button` has no `pending` prop. Most components carry
*some* `loading` boolean, but nothing enforces it, so a new component starts
unguarded by default and correctness depends on the author remembering.

**And the server-side backstop is off.** Six handlers declare `concurrency: 1` — the
thing that should refuse a second simultaneous click. `isShadowMode()` returns true
unless `RATE_LIMIT_MODE=enforce`, so none of it is enforced. See the report at the
end: **turning it on today would break normal browsing**, for a reason worth knowing
before anyone tries.

---

## Decisions taken

| # | Decision |
|---|---|
| 1 | Fix the tab re-navigation |
| 2 | Add a shared async hook: in-flight guard, cancellation, and stale-response drop |
| 3 | Give the shared `Button` a `pending` prop so guarding is the default, not a per-site decision |
| 4 | Server-side idempotency for the irreversible mutations |
| 5 | Rate limiting stays in shadow mode for now — report first, env change is the user's call |

**Governing constraint: the client cannot be the only defence on an irreversible
path.** A React boolean does not survive a duplicated tab, a refresh mid-request, or
a network-level retry. Layers 1–3 make the common case stop happening; layer 4 is the
only one that still holds when they are bypassed.

---

## Phases and gates

### Phase 1 — The tab fix · one line

Skip the push when the tab is already current. `TabBar.tsx` is the only tab component
that pushes; the rest of the app navigates by `<Link>` or URL params.

**Exit:** clicking the active tab issues no navigation and runs no query. Verified by
watching the server log — every route logs with a `requestId`.

---

### Phase 2 — `lib/hooks/useAsync.ts`

One hook, three jobs, in this order of importance:

1. **Drop a stale response.** Track a request sequence; ignore any response that is
   not the latest. This is what fixes the `RateHistoryDialog` class of bug.
2. **Cancel the superseded request** with `AbortController`, so the work is abandoned
   rather than merely ignored.
3. **Expose `pending`** so a second trigger is a no-op while one is in flight.

Migrate the read panels and dialogs first — they are the ones with the stale-overwrite
bug and the lowest risk to change: `RateHistoryDialog`, `EntityHistoryDialog`,
`PoHistoryDialog`, `RecipeDetailPanel`, `CsvPreviewDialog`, `ThreeWaySummary`,
`CostImpactAlert`.

> **Not a data-fetching library.** No cache, no revalidation, no query keys. The app
> renders most data server-side already; this covers the client-side panels that fetch
> on open. If a real cache is ever wanted, that is a separate decision with a
> dependency attached.

**Exit:** the panels above cannot show one row's data under another row's heading.
A unit test on the hook's sequencing, since that is pure logic.

---

### Phase 3 — `pending` on `Button`

`components/ui/button.tsx` already has `disabled:pointer-events-none`. Add a `pending`
prop that sets `disabled` and shows a spinner, so "don't fire twice" stops being a
decision each call site re-makes.

Adopt at the submit sites that mutate. **Not a blanket find-and-replace** — a button
that opens a dialog does not need it, and adding it everywhere would train people to
ignore it.

**Exit:** every button that POSTs is `pending`-guarded.

---

### Phase 4 — Idempotency on the irreversible mutations · GATE before building

The routes where a duplicate submit is not merely wasteful:

| Route | Why a repeat is expensive | Rate limit today |
|---|---|---|
| `POST /api/v1/gatepass/create` | Raises a gatepass in Unicommerce. **Uniware has no delete** — a duplicate is permanent, and the serial comes from `max+1` so two runs make two series entries | **none** |
| `POST /api/v1/purchase-orders/invoice` | Mirrors a PO into Unicommerce *inside* the open transaction, then mails the warehouse | limit 20, concurrency 1 |
| `POST /api/v1/approvals/[id]` | Applies a master change | none — but it re-checks `status = 'pending'` and 409s, so it is **already idempotent in effect** |

**`gatepass/create` has no server-side protection at all.** Its only guard is
`GatepassClient`'s `running` boolean. That is the gap worth closing.

Shape: the client sends a generated key, the server records it against the outcome and
returns the first result for a repeat rather than doing the work twice. Where the key
is stored (a table, or a column on the existing row) is the design question, and it is
what the gate is for — a new table for this is a bigger commitment than the problem may
warrant.

> `approvals/[id]` shows the cheaper pattern: re-read the row, refuse if it is no
> longer in the state the operation assumes. Where a natural state check exists, that
> beats an idempotency key. Worth checking whether gatepass has one — a gatepass code
> already searched for by serial may be enough.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **A `pending` guard that never clears leaves a dead button.** A throw before `finally` is how | The hook owns the flag; call sites never set it by hand. Phase 3 depends on Phase 2 for that reason |
| **Cancelling a request the server already acted on.** Abort stops the client reading the response, not the server writing | Never abort a mutation — Phase 2's cancellation is for reads only. Mutations get the in-flight guard and nothing else |
| **Phase 2 becomes a data-fetching library** | Stated non-goal above. No cache, no revalidation |
| **Blanket `pending` trains people to ignore it** | Mutating submits only |
| **An idempotency table nobody prunes** | Decide retention at the Phase 4 gate, before building |
| **The real fix is server-side and we stop after Phase 3** | Phase 4 is the only layer that survives a duplicated tab or a network retry. Layers 1–3 reduce frequency; they do not make it safe |

---

## Appendix — enabling rate limiting, and why not yet

`lib/gateway/rate-limit.ts:44` — `isShadowMode()` is true unless
`RATE_LIMIT_MODE=enforce`. A denial is computed, logged as `wouldBlock: true`, and the
request proceeds.

The six declarations:

| Route | limit / 10 min | concurrency | instance |
|---|---:|---:|---:|
| `POST /purchase-orders/invoice` | 20 | 1 | 3 |
| `POST /v2/.../invoice/parse` | 12 | 2 | 6 |
| `GET /uniware/explorer` | 30 | 1 | — |
| `GET /uniware/explorer/documents` | 60 | 2 | — |
| `POST /purchase-orders/uniware-grn` | 6 | 1 | — |
| **`GET /purchase-orders/[id]/inwarding`** | **10** | 1 | — |

**Do not set `RATE_LIMIT_MODE=enforce` as it stands.** `/purchase-orders/[id]/inwarding`
is a **GET that fires when a user expands a PO row**, capped at **10 per 10 minutes per
user**. Someone reviewing a dozen POs would be refused on the eleventh — a 429 during
ordinary browsing, which reads as the app being broken.

The `concurrency` gates are the ones that address this plan's problem, and they are
sound: keyed `path:userId`, so `concurrency: 1` refuses exactly the second simultaneous
click by the same person without affecting anyone else.

**To enable safely:** raise or remove the `limit` on `[id]/inwarding` (concurrency
alone is what it needs), re-read the other five limits against real usage from
`activity_log`, then set the variable. That is an environment change on EC2, not a
deploy.

Two properties to know either way:

- **State is in-process** (`hits` and `inFlight` are module-level `Map`s). One EC2
  instance today, so it holds — but it is per-process, not shared, and would need
  rethinking behind more than one.
- **Four of the six gates are on GETs.** Rate limiting reads is a load control, not a
  double-submit guard. The double-submit protection this plan needs is `concurrency`,
  and `gatepass/create` — the most irreversible route in the app — declares neither.
