# Module Boundaries & Tally Integration Plan

**Status:** proposed, not started (except Track A, in progress)
**Date:** 2026-08-24
**Supersedes nothing.** Complements `docs/api-hardening-plan.md` — see §1.

---

## 1. Scope, and what this plan is *not*

`docs/api-hardening-plan.md` already covers session revocation, rate limiting,
security headers, pagination caps and error-shape drift. **Do not re-plan those
here.** This document covers the three things it did not:

| Track | Why it isn't in the hardening plan |
|---|---|
| **A. Entity scope** | That plan counted `assertInScope` coverage as a method note but never made it a finding. Four id-addressed routes read across scope. |
| **B. UI ↔ API boundary** | 25 files outside `app/api/` read the database directly. Not a security finding on its own, but it is where the Track A bugs came from, and it is the only real obstacle to ever separating frontend from backend. |
| **C. Tally integration** | New work. Planned here because it is the first module with a genuine reason to be a separate deployable. |

One overlap is deliberate: `files/preview` is Finding 3 of the hardening plan
and Phase 0 below. It is listed here only because the in-flight fix is broken.

---

## 2. Phase 0 — two corrections, before any new work

Both are in-flight changes that need finishing, not new scope.

### 0.1 `app/api/v1/files/preview/route.ts:20` throws at runtime

```ts
await assertKeyReadable(Number(sessionStorage.user.id), key)
//                             ^^^^^^^^^^^^^^ browser global; undefined on the server
```

`sessionStorage` is a DOM global. On Node this is a `ReferenceError` on every
request, so the approvals CSV preview is currently dead for all users.

It type-checks because `lib.dom`'s `Storage` interface carries
`[name: string]: any`, so `sessionStorage.user.id` is `any` and `tsc` has nothing
to object to. Worth noting as evidence for the `any` sweep in §5 — a real bug
walked through a clean type check.

Fix: take `session` from the handler args, which is what every other route does.

```ts
handler: async ({ req, session }) => {
  ...
  await assertKeyReadable(Number(session.user.id), key)
```

Also delete line 21 (`key.includes("..")`). It is not a weaker check than
`assertKeyReadable`, it is a check of nothing — S3 keys are flat strings, not
paths, and `presign/route.ts:22-24` already records that. Leaving it implies a
protection that does not exist.

### 0.2 Decide v1 vs v2 for `files/preview`

`app/api/v2/files/preview/route.ts` is correct. `app/api/v1/files/preview/route.ts`
is the one receiving traffic (`app/approvals/CsvPreviewDialog.tsx:30`). Two
copies of a security-sensitive route is worse than one, because the next person
hardens whichever they find first.

Per the "never delete an API route" rule, v1 stays — so **v1 must carry the
fix**, and v2 is either pointed at by the client or left as the forward-looking
copy with a comment saying v1 is authoritative until the client moves. Pick one
and write it in the file header. Do not leave both live and unexplained.

**Acceptance:** the CSV preview works in the approvals UI; a user without
`/approvals` access gets 403; a user passing someone else's key gets 403.

---

## 3. Track A — entity scope (in progress)

### 3.1 What is already right

`lib/gateway/scope-rules.ts` is the correct design: a declarative `scope` option
on `withGateway`, one resolver per subject, so a route that takes an id cannot
silently forget. Keep it.

The guards it needs mostly exist already:

| Subject | Guard | Location |
|---|---|---|
| `po` | `assertPoInScope` | `lib/po/po-guard.ts` |
| `invoice` | `assertInvoiceInScope` | `lib/invoice/invoice-guard.ts:26` |
| `recipe` | `assertRecipeInBrandScope` | `lib/brand-guard.ts:71` |
| `sku` | `assertSkuIdInBrandScope` | `lib/brand-guard.ts:56` |
| `mfg`/`vendor`/`warehouse` | `assertInScope` | `lib/scope.ts:140` |

The gapped routes were never missing a guard. They were missing a *call*.

### 3.2 The four routes

| Route | Why it leaks | Fix |
|---|---|---|
| `purchase-orders/invoice/[id]` | `selectInvoiceById` is `WHERE si.id = ?` returning `si.*` — GSTINs, bill-to address, line rates. The list applies mfg + destination + brand scope. | `scope: { type: "invoice", … }` — **done** |
| `masters/recipe-master/[id]` | `selectHeaderById` is `WHERE b.id = ?`. The list filters `s.brand_id IN (?)` (`recipe.ts:115`) and the write path calls `assertSkuIdInBrandScope`. Reads bypass both. | `scope: { type: "recipe", … }` |
| `masters/recipe-master/history/[id]` | Same query, same gap. | `scope: { type: "recipe", … }` |
| `approvals/[id]` | Page permission only. An approver scoped to brand A can approve a brand-B recipe change. | **Policy decision, not a bug** — see 3.3 |

Also delete the docblock claim in `recipe-master/[id]/route.ts`:

> *"Gated by the same "/masters" viewer permission as the listing page — guards
> against a user reaching another Recipe's details by editing the id in the URL."*

Page permission is not scope. Either the route enforces scope or the comment
goes; right now it is a false assurance in the one place someone would look.

### 3.3 The approvals decision

Approvers are plausibly meant to be global — a finance approver may legitimately
need to see every brand. That is a defensible design, but it is currently
*implicit*. Decide, and record it in `docs/admin-and-data-scoping.md`:

- **Global approvers** → add a comment to `approvals/[id]/route.ts` saying scope
  is deliberately not applied, and why.
- **Scoped approvers** → add `scope` keyed on the approval's `(module, entity_id)`,
  which means one resolver per module. Meaningfully more work; only do it if the
  answer is genuinely "an approver must not see other brands".

### 3.4 Tests

This is the part that prevents the fifth occurrence. One DB test file,
`tests/db/route-scope.test.ts`, asserting that for each id-addressed route a
user scoped away from the record gets 403 rather than a body. Use `withRollback`
and the existing fixture builders; model it on `tests/db/brand-scope.test.ts`.

**Acceptance:** every route under a `[id]`/`[mfgId]` segment either declares
`scope` or carries a comment saying why it doesn't. A grep is the check.

**Effort:** S. Two route lines, one policy note, one test file.

---

## 4. Track B — the UI ↔ API boundary

### 4.1 The finding

25 files outside `app/api/` import `@/lib/db`, `@/lib/db-sku` or
`@/lib/queries/*` and read the database directly from Server Components:

```
app/masters/{skus,vendors,manufacturers,raw-materials,packing-materials,
             material-master,recipe-master,recipe-master/history,warehouses}/page.tsx
app/po-tracking/{po-procurement,po-inwarding,mfg-overview,
                 po-procurement/entity-emails}/page.tsx
app/manufacturing/page.tsx        app/manufacturing/[mfgId]/page.tsx
app/approvals/page.tsx            app/approvals/history/page.tsx
app/admin/{page,layout,activity,data-access,permissions}.tsx
app/admin/{UserDialog,UsersClient}.tsx
app/layout.tsx
```

Several carry scope logic inline — `scopeParams(scope.brandIds)` appears in page
bodies. So authorization currently lives in 74 routes **and** 25 pages. That is
the actual root cause of Track A: there is no single place where "who may read
this" is decided.

### 4.2 What NOT to do

**Do not convert page reads into `fetch()` calls to our own API.** In the App
Router that means absolute URLs, manual cookie forwarding, a second
serialization pass and an extra network hop for data the process could read
directly. It would be slower and more code, and it only pays off in a
frontend-only world that has not been committed to.

### 4.3 What to do instead — `lib/services/*`

`docs/architecture-evolution.md:57` already proposed this and recorded that the
extraction was deferred. Revive it: one function per read, owning **both** the
query and its authorization.

```
lib/services/skus.ts     →  listSkus(userId, filters)   // scope resolved inside
lib/services/recipe.ts   →  getRecipe(userId, recipeId)
lib/services/invoices.ts →  listInvoices(userId, filters)
```

The API route calls it. The page calls it. Neither decides scope.

Why this is the right step in both futures:

- **If you never separate:** authorization gets exactly one home, which is the
  Track A fix generalised. Pages stop being able to forget scope because they no
  longer touch SQL.
- **If you do separate:** the service function is the seam. Swapping its body
  for an HTTP client is a one-file change per domain, and every page and route
  keeps its call site unchanged.

That is the test for any architecture step worth taking now: it pays off whether
or not the speculative future arrives.

### 4.4 Enforcement, because discipline doesn't hold

`eslint.config.mjs` currently has no custom rules. Add a boundary, and lean on
the ratchet you already run (`npm run lint:changed`) so it fails only on files
you touch — the same mechanism carrying the ~238 pre-existing errors:

```js
{
  files: ["app/**/*.{ts,tsx}"],
  ignores: ["app/api/**"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["@/lib/db", "@/lib/db-sku", "@/lib/queries/*"],
        message: "UI must not read the DB directly. Call a lib/services/* function so scope stays in one place." },
    ]}],
  },
},
```

No big-bang migration. The 25 convert as they are edited, and nothing new joins
them.

### 4.5 Order within the track

Not alphabetical — risk first.

1. **Pages whose reads carry scope logic** (`po-procurement`, `po-inwarding`,
   `mfg-overview`, `masters/recipe-master`, `masters/skus`). These are the ones
   that can leak, and they are the reason the track exists.
2. **`app/layout.tsx` and `app/admin/layout.tsx`.** Layout-level reads run on
   every navigation; getting them behind a service also gives one place to cache.
3. **Everything else, on touch.** The lint rule makes this automatic.

**Acceptance:** `grep -rl "@/lib/queries/" app --include=*.tsx | grep -v app/api`
returns nothing, and the lint rule is in place so it stays that way. Reaching
zero is a months-long tail; the rule is what matters, not the date.

**Effort:** M per page, but spread across normal feature work rather than booked
as a project.

---

## 5. Track C — Tally

### 5.1 Blocked on one fact

Everything below assumes Tally speaks the Gateway Server XML interface (HTTP on
port 9000 of a machine running Tally). **Confirm where Tally runs before
building the transport**, per the three checks discussed:

1. How accountants open it — one shared machine (server/VPS) or individual PCs.
2. `Help → Settings → Connectivity` on that machine: is it acting as a server,
   on which port.
3. `http://<host>:9000` from another machine on the same network.

Also confirm whether it is a "Tally on Cloud" reseller VPS — if so the reseller
controls the firewall and may not open the port at all.

**This blocks only the transport.** Envelope building, XML parsing, mapping and
the outbox are identical in every topology, so T1 below can start immediately.

### 5.2 Module layout — follow `lib/nanonets/`, not `lib/uniware.ts`

`lib/uniware.ts` is 776 lines mixing auth, facility policy, PO push, export jobs
and error parsing, with three more files at `lib/` root. `lib/nanonets/` splits
transport, endpoints, wire-schema and mapping, and pins its URLs with a unit
test after a find-replace once rewrote one to `/api/v1/v2/`. Copy the second.

```
lib/tally/
  client.ts        POST an XML envelope, return the body. The ONLY file the
                   host topology affects.
  envelopes.ts     Request builders (Export/Data, ledger masters, vouchers).
  parse.ts         XML → typed rows. Pure, unit-testable.
  mapping.ts       Tally ledger ⇄ master_vendors / master_mfgs. Pure.
  index.ts         Public surface.
lib/queries/tally.ts     SQL for the mapping + outbox tables.
app/api/v1/tally/        Routes (withGateway, access, scope, rateLimit).
```

`client.ts`, `parse.ts` and `mapping.ts` being separate is what lets the parser
and mapper be unit-tested with no Tally, no network and no credentials — the
same constraint that shaped `lib/po/po-rules.ts` and `lib/invoice/invoice-merge.ts`.

### 5.3 Phases — the order is forced by dependency

**T1 — pull masters → mapping table.** Nothing else is possible first: a voucher
cannot be posted until we know which Tally ledger a vendor *is*. Read-only, zero
risk to the books, and it is where the messy truth surfaces (duplicate ledger
names, ledgers with no ERP counterpart, unexpected group hierarchies).

Model the table on `un_code_mfg_sku_wh_map` — one row per (our entity, Tally
ledger), with the unmapped state **visible in the UI** rather than silently
skipped. Carry that table's hard-won lesson: if the uniqueness rule can't be a
DB constraint, it must be enforced in application code *and* pinned by a test
(`tests/db/mfg-facility-map.test.ts` is the precedent).

**T2 — pull balances / outstandings.** Still read-only. Delivers something
finance can see within days, and it exercises transport and parsing against real
volume before anything can go wrong.

**T3 — push documents.** Needs T1's mappings and T2's proven transport.

- **Outbox, not a synchronous push.** Tally will be closed, asleep or locked a
  meaningful fraction of the time; a handler that posts inline will fail
  routinely and leave no record of what landed. Copy the shape that already
  works: `invoice_mfg.uniware_po_code` / `uniware_status` / `uniware_synced_at`
  plus the sweep in `uniware-status/route.ts`.
- **Idempotency as a DB constraint.** A double-posted voucher is discovered
  weeks later by an accountant and is materially worse than a duplicate PO. Use
  the `uq_supplier_invoice (mfg_id, invoice_no)` trick — a unique key caught as
  `ER_DUP_ENTRY` rather than a pre-check, so two concurrent posts cannot both
  pass.

**T4 — reconciliation.** By definition a diff of two things T1–T3 can already
read. Nearly free once they exist, and it is what reveals how wrong the earlier
phases were.

### 5.4 The agent, and why it's the one justified separate deployable

If Tally is on-prem, the ERP on EC2 cannot reach it, and Tally's XML port is
**unauthenticated** — anything that can reach it can read and write the books.
It must never be internet-exposed.

A small on-prem agent next to Tally, talking to `localhost:9000` and dialling
*out* to the ERP over HTTPS with a bearer token, needs no VPN, no inbound
firewall rule and no static office IP. Note the reason it is separate: it *runs
somewhere else*. That is a physical constraint, not a domain boundary — which is
exactly the distinction §6 is about.

Check first whether the existing `AWS-VPN` instance (`i-0fad3b0ab65100369`)
already links to the office. If it does, the ERP can call Tally directly and the
agent is unnecessary.

### 5.5 Environment pinning — a lesson from 2026-08-21

`UNIWARE_SANDBOX = APP_ENV !== "prod"` pins the facility to `TEST_FACILITY` off
prod. The pattern is right; its failure mode cost an afternoon: the *facility*
was pinned to sandbox while the *credentials* pointed at the production tenant,
and the two disagreeing produced a 403 that read as a credentials problem.

For Tally, derive **host and company name from one `APP_ENV`-keyed object**, so
dev cannot post into the live company. A wrong voucher in real books is not
recoverable the way a wrong Uniware facility is. Ask finance for a duplicated
company file before T3 — the same dev/prod split as `mcaff_prefg_dev`.

---

## 6. Explicitly not in this plan

Recorded so they don't get re-proposed.

| Not doing | Why |
|---|---|
| Splitting the ERP into services now | `docs/architecture-evolution.md:36` deferred it and §8 names the triggers: independent deploy cadence, or one codebase/DB becoming the bottleneck. Neither is met. |
| Making Next.js frontend-only | The API and `lib` layers are already portable — no runtime ORM, SQL grouped by domain, pure logic extracted, one gateway over 72 of 74 routes. The obstacle is Track B, which is worth doing regardless. Revisit after Tally proves what a cross-process boundary actually costs. |
| Splitting masters/approvals by domain | `applyAndArchive` receives an open `PoolConnection` and writes `master_recipe` + `details_recipe` + `history_recipe` + `master_skus` atomically. Splitting turns that into a saga with compensating writes, and takes the `withRollback` test harness with it. |
| Kong / Kubernetes / per-service DB | Same trigger conditions as above. |
| Converting page reads to `fetch()` | Slower and more code than `lib/services/*`, and only pays off in a future not committed to. See 4.2. |
| A big-bang migration of the 25 files | The lint ratchet converts them on touch. A sweep would be one enormous untestable diff. |
| Exposing Tally's port 9000 | Unauthenticated read/write access to the books. Not negotiable. |

---

## 7. Sequencing across tracks

Independently deployable, independently revertable. Do not batch.

| Order | Work | Effort | Blocked on |
|---|---|---|---|
| 1 | Phase 0 (both corrections) | XS | — |
| 2 | Track A: two `scope` lines, policy note, `tests/db/route-scope.test.ts` | S | — |
| 3 | Track B: the ESLint rule alone | XS | — |
| 4 | `docs/api-hardening-plan.md` Phase 1 (session revocation) | S | — |
| 5 | Track C / T1: mapping table + masters pull | M | Tally host answer (transport only) |
| 6 | Track B: the five scope-carrying pages → `lib/services/*` | M | 3 |
| 7 | Hardening Phase 2 (rate limits, headers) | S | — |
| 8 | Track C / T2 → T3 → T4 | L | 5, and a test company for T3 |

Items 1–4 are all small, independent, and close real holes. They should land
before any Tally code.

---

## 8. Open questions

1. **Where does Tally run?** Blocks 5.1's transport choice and the agent
   decision. Everything else in T1 can proceed.
2. **Are approvers global or brand-scoped?** Blocks 3.3. A one-line answer.
3. **Does the `AWS-VPN` instance already reach the office network?** If yes,
   5.4's agent may be unnecessary.
4. **Is there a Tally test company**, or does one need creating? Blocks T3 only.
</content>
</invoke>
