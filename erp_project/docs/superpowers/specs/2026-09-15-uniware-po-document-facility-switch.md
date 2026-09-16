# Attaching the Uniware PO document at every facility

> Status: **steps 1–3 implemented 2026-09-15**; `tsc`, 672 unit tests and eslint
> clean. Still open: the mint pre-gate below (unanswered), step 4 (session age is
> surfaced only at commit time, not before), and prod verification — two invoices
> at one non-Gurgaon site, one per legal entity.
> Evidence: `check_uniware_apis/po_document.py` FINDINGS (gitignored — that block
> is the only record of the measurements this plan rests on).

## The problem, in one line

The warehouse mail attaches the Uniware PO document for `GGN_WAREHOUSE` and for
nowhere else, because `/po/show` renders only the calling session's **currently
selected facility**, and the ERP's session is parked on Gurgaon.

Reported since 2026-09-09 as the `email` step's `warning` status — it is visible,
not silent. This plan removes the cause.

## What was measured (2026-09-15, prod, `erp.prefg@`)

| | switch | then fetch a MUM PO |
|---|---|---|
| OAuth bearer | `500` Tomcat error page | `500` Internal Error |
| Web cookie | `200 successful:true` | `200` **PDF, 7638 bytes** |

- The switcher is `POST /data/user/switchfacility` `{currentUrl, facilityCode}`.
- `/data/*` is **web-session only** — same as `/data/document/auth/details/get`,
  which the document client already depends on. There is no bearer-reachable way
  to move a session's facility.
- `/po/show` accepts **either** arm and renders whatever facility *that session*
  is on. Cookie and bearer are separate sessions: switching one and fetching with
  the other proves nothing and would ship as a silent no-op.
- `legacy=1` still selects the PDF renderer on the cookie arm.

## The decision already taken

Render-it-ourselves (from `getPurchaseOrderDetails`, bearer, all 18 facilities,
no cookie) was offered and **declined** — the warehouse needs Uniware's own
document. So this builds the cookie + switch path, and accepts its costs
explicitly rather than discovering them later.

---

## Sequencing

Four steps, each landing on its own and reversible by the one before it.

**1 — `switchFacility()` in the Uniware client, unused.**
Ship the call and its staleness handling with no caller. Verified by pointing the
probe at it, not by the ERP. Nothing in the app changes, so this cannot regress
the mail.

**2 — Serialise the cookie.** Introduce the mutex *before* anything uses it, so
there is never a window where two cookie operations can interleave. Route the
existing `mintCapability` through it at the same time — the document sync is the
other consumer and it is already live.

**3 — Move `fetchPurchaseOrderPdf` onto the cookie arm**, behind the mutex,
switching to the resolved facility first. This is the only step that changes what
the warehouse receives.

**4 — Make the dependency visible.** The cookie now gates an attachment on every
invoice commit, not just the document sync. Whatever surfaces session age today
has to be somewhere the inwarding desk actually looks.

## Gates

Between 1 and 2 — the probe proves `switchFacility()` against **two** facilities,
one of them not Gurgaon, and proves a stale cookie surfaces as
`UniwareSessionStale` rather than a generic 500.

Between 2 and 3 — run the document sync with the mutex in place and confirm its
pull/push counts are unchanged. If the mutex has broken the sync, the mail change
must not ride on top of it.

Between 3 and 4 — file one real invoice per legal entity at a **non-Gurgaon**
site and confirm the mail carries two attachments. One facility proves the switch;
two entities prove the resolver, because that is where `HYP_B2B_MUM2` vs
`MUM_WAREHOUSE2` bites.

Before any of it — **check whether the document sync's mint is itself
facility-scoped.** Everything below assumes it is not. If it is, step 2 grows a
switch of its own and step 3 must not land first. One probe run answers it: mint
for a Mumbai PO with the session parked on Gurgaon.

## Governance

- **The switch mutates shared state.** Four things sit on `erp.prefg@`: the prod
  container, the test container, `fetch_sku_details.py`, and the document sync.
  The mutex covers one process. Two containers switching the same session cannot
  be serialised in application code, and will not be — see Risks.
- **No switch-back.** Every operation states the facility it needs; leaving the
  session wherever the last one put it is what makes that safe. A switch-back is
  a second mutation with its own failure mode and buys nothing.
- **Dev/prod:** off prod, `uniwareFacility()` pins `TEST_FACILITY`, so the switch
  target must go through that same helper — otherwise a dev box switches a live
  prod session to a facility nobody asked for.
- **The cookie is a live session for a real Workspace account.** It stays out of
  logs, out of API responses, and out of the browser, exactly as today.

## Risks, and what each one costs

| Risk | Cost if it fires | Mitigation |
|---|---|---|
| Two containers race the facility | One mail's attachment is the wrong facility's PO, or a 500 | **Not mitigable in app code.** Test's Uniware config should be unset so it never touches prod's session. Verify before step 3. |
| Cookie expires (~10h, human renews) | Attachment silently missing again — the exact bug being fixed, with more machinery | Step 4. This is the real cost of the chosen approach. |
| Mint turns out facility-scoped | Document sync breaks when the mail leaves the session elsewhere | The pre-gate probe above |
| `/po/show` is rate-limited per session | Bulk invoice runs lose attachments | Unknown — nobody has pushed it. Watch the first week |

**The honest summary:** this trades a deterministic failure (17 facilities never
work) for an intermittent one (any facility fails when the cookie is stale or
another process moved the session). That is a real trade, chosen deliberately
because the warehouse needs Uniware's document. Step 4 is what keeps the new
failure mode from being invisible, and it is not optional.

---

## Code structure

### 1. `lib/uniware/facility-switch.ts` (new)

```ts
// POST /data/user/switchfacility — the facility is SESSION state, and /data/* is
// web-cookie only (the bearer gets 500). Measured 2026-09-15.
export async function switchFacility(facilityCode: string): Promise<void>
```

Uses `requireUniwareWebCookie()`, posts `{ currentUrl: "/dashboard/overview",
facilityCode }`, and mirrors `mintWithCookie`'s error handling exactly: non-JSON
or `USER_NOT_LOGGED_IN`/401 ⇒ `UniwareSessionStale`, `successful: false` ⇒
`Error` carrying Uniware's own description.

Its own file rather than `document.ts`: that module is the documents *client*, and
this is session control that the PO fetch needs without any document concept.

### 2. The mutex

A module-level promise chain in `lib/uniware/web-session.ts` — it already owns the
cookie, so the thing being serialised and the lock live together.

```ts
export function withCookieSession<T>(fn: () => Promise<T>): Promise<T>
```

`mintCapability` (`document.ts:108`) wraps its body in it. Not the whole
`syncDocumentsForInvoice` — the downloads are self-authorising and hold no
session state, so serialising them would turn a 40-invoice sweep into a queue for
no reason.

### 3. `fetchPurchaseOrderPdf` (`lib/uniware/purchase-order.ts:76`)

```ts
return withCookieSession(async () => {
  await switchFacility(uniwareFacility(facility))
  // GET /po/show?code=…&legacy=1 with Cookie, not Authorization
})
```

The `Facility` header goes — this endpoint ignores it, and leaving it in implies
it does something. `uniwareFacility()` stays, for the sandbox pin and the
refuse-TEST_FACILITY-on-prod guard.

`lib/mail/mailer.ts:764` needs no change: it already passes `facility` and already
catches failure into `missingPoDocument`.

### 4. Tests

`tests/unit/uniware-facility.test.ts:138` currently asserts the **`Facility`
header** on `fetchPurchaseOrderPdf`. That assertion becomes wrong and must be
replaced, not deleted — the new one asserts the switch fires with the resolved
facility *before* the `/po/show` request, and that both carry the cookie. Its
comment ("facility-scoped like the REST endpoints") is now measurably false;
rewrite it or it will mislead the next reader into re-adding the header.

Add: a stale cookie surfaces as `UniwareSessionStale` and not as a generic error,
since the mailer's catch-all would otherwise swallow the one failure a human can
fix.

---

## What this does not do

- Does not switch back. Stated under Governance.
- Does not make the mail fail when the attachment is missing. It stays
  best-effort with a `warning`; the goods are physically here.
- Does not touch the document sync's own facility handling beyond the mutex.
- Does not remove `render-it-ourselves` as a future option — nothing here forecloses it,
  and it stays the answer if the cookie renewal proves unsustainable.
