# Uniware PO documents — in the ERP app, both directions

**Goal.** Two things, one mechanism, all inside the Next.js app:

- **Push** — when an invoice is inwarded, the supplier invoice PDF lands on the
  Uniware PO, so the warehouse sees it while receiving.
- **Pull** — a "Sync Documents" button fetches whatever the warehouse attached
  (the signed copy above all) into our S3, readable from the ERP.

**Scope for now: `TEST_FACILITY` only.** Every sweep filters to the sandbox
facility so nothing in real operations changes. Going live later widens one
predicate; nothing else moves.

---

## The one constraint that shapes everything

Documents are minted at
`POST pep.unicommerce.com/data/document/auth/details/get`, which takes the
**tenant web cookie** — measured 2026-09-01: our OAuth bearer → HTTP 500,
anonymous → 401, cookie → 200. That cookie comes only from a Google SSO login
(Keycloak realm `google_only`, 2FA, no password form), and the mint endpoint
sends **no CORS headers**, so a browser cannot mint cross-origin either.

Two consequences, both settled by "do it in the app":

1. **In the app = server-side = the cookie must be stored.** There is no
   browserless login and no in-browser mint. One row holds the session.
2. **Access is governed by ERP scope, not per-user Uniware login.** Once a
   document is in our S3, `KEY_OWNER_SELECTS` decides who may open it — exactly
   as it already does for the invoice PDF, PO attachments and vendor documents.
   This is the deliberate trade of putting the files in the ERP.

Everything downstream of the mint is plain server-side `fetch`: the
token+checksum pair is self-authorising on `docs.unicommerce.com`, needs no
cookie, and never expires. So the stored cookie is the ONLY perishable piece.

---

## Architecture — five layers, all in the app

```
 ┌──────────────────────────────────────── UI ────────────────────────────────┐
 │  Invoices tab: "Sync Documents" button   +   attachments in the row expansion │
 └───────────────┬─────────────────────────────────────────────┬───────────────┘
                 │ POST                                          │ GET presign
 ┌───────────────▼───────────────┐            ┌─────────────────▼───────────────┐
 │ /uniware-documents  (button)   │            │ /files/presign  (existing)       │
 │  — thin wrapper over the sweep │            │  — opens a stored attachment     │
 └───────────────┬───────────────┘            └──────────────────────────────────┘
                 │
 ┌───────────────▼──────────────────────────────────────────────────────────────┐
 │ lib/uniware/document-sync.ts   — the callable sweep (pull + push), TEST_FACILITY │
 └───────┬───────────────────────────────┬───────────────────────────┬──────────┘
         │                               │                           │
 ┌───────▼────────┐          ┌───────────▼──────────┐     ┌──────────▼─────────┐
 │ web-session.ts │          │ documents.ts         │     │ s3 + attachments_   │
 │ stored cookie  │          │ mint/list/up/download │     │ invoice (existing   │
 │                │          │ (plain fetch)         │     │ uploadFile + SQL)   │
 └───────▲────────┘          └───────────────────────┘     └────────────────────┘
         │ POST /api/v1/uniware/session   (stores the cookie)
 ┌───────┴──────────────────────────────────────────────────────────────────────┐
 │ Chrome extension "ERP Uniware Session"  — the ONLY human step.                  │
 │  Someone already signed into Uniware clicks one icon; the extension reads the   │
 │  pep.unicommerce.com cookies and POSTs them here. ~once every 10 hours, by      │
 │  ANYONE with Uniware access — not only a developer.                             │
 └────────────────────────────────────────────────────────────────────────────────┘
```

### Layer 1 — the stored cookie  (`lib/uniware/web-session.ts`, ✅ written)

One row, `uniware_web_session`. `requireUniwareWebCookie()` reads it;
`UniwareSessionStale` is thrown when it is missing or rejected. Staleness is
detected by **response content, never HTTP status** — these routes answer 200
with an HTML shell, so "did it work" is "did the body parse as JSON with
`successful:true`". The value is never logged, never returned to a browser.

### Layer 2 — the document client  (`lib/uniware/documents.ts`, new)

Plain server-side `fetch`, all proven this session:

```ts
mintCapability(uniwarePoCode)  // POST /data/document/auth/details/get (cookie) → {token,checksum,url,identifier}
listDocuments(cap)             // GET  <url>/documents/list            → [{fileName,documentLocation,uploadedBy,created}]
downloadDocument(cap, name)    // GET  <url>/document/V2/download      → presignedDownloadUrl → bytes
uploadDocument(cap, name, buf) // GET  .../upload → PUT bytes → POST .../acknowledge/upload
```

`mintCapability` runs the shell-vs-JSON check and throws `UniwareSessionStale`
on a shell — that is the single place session death is detected. `url` comes
from the mint response; the docs host is never hardcoded.

### Layer 3 — the sweep  (`lib/uniware/document-sync.ts`, new)

A **callable**, so a scheduler can reuse it — same shape as `grn-sync.ts`.
Copies `uniware-status/route.ts` almost exactly:

```
for each invoice with a uniware_po_code, capped, TEST_FACILITY only:
  resolve facility (requireFacilityForInvoice); skip if not TEST_FACILITY
  cap = mintCapability(po_code)
  PULL:  for each listed filename not already held → download → S3 → INSERT (source='uniware')
  PUSH:  if the invoice's own PDF isn't up yet    → read S3 → upload → INSERT (source='erp')
never throws per invoice; a UniwareSessionStale aborts the whole run early
returns { total, pulled, pushed, skipped, failed, failures, sessionStale }
```

`source` is what stops the push re-uploading and the pull re-downloading our own
push. Filename is the dedupe key, matching Uniware's `&filename=` download
addressing.

### Layer 4 — the routes

- `app/api/v1/purchase-orders/uniware-documents/route.ts` (new) — the button.
  `access: { pageSlug: "/po-tracking", level: "editor" }`, `maxDuration = 300`,
  wraps the sweep. Reports counts and `sessionStale` so the UI can say "log in
  again" rather than a silent zero.
- `app/api/v1/uniware/session/route.ts` (new) — where the extension POSTs the
  cookie. See the cookie-refresh section for its self-validating auth.
- `/files/presign` (existing) — opens a stored attachment. Needs the guard below.

**Non-optional:** add `attachments_invoice` to `KEY_OWNER_SELECTS` in
`lib/queries/s3-files.ts`, joined to `invoice_mfg` for `mfg_id`. Without it the
files are unopenable, and it is what keeps them inside entity scope.

### Layer 5 — the push, inline in invoice commit  (`lib/invoice/invoice-inward.ts`)

A `docs` step **after `uniware`, before `email`**, and **non-fatal**: a stale
cookie makes it report `skipped`, never fails a committed invoice. A skipped push
is picked up by the next button run — which is why one button does both
directions. Off `TEST_FACILITY` the step is a no-op for now.

---

## The cookie refresh — a Chrome extension

`google_only` means the session can only be minted by a human in a real browser
that can pass Google 2FA — no server, on EC2 or anywhere, can do it. The trick is
that whoever refreshes it is **already** logged into Uniware in their normal
Chrome. The extension just lifts the cookies out of that session and hands them
to the ERP. One icon click, no terminal, no bundled browser.

### The extension  (`uniware_session_extension/`, Manifest V3, ~100 lines)

```
manifest.json   permissions: ["cookies"]; host_permissions: pep + the ERP origin
popup.html      one "Send session to ERP" button, an ERP-URL field, a status line
popup.js        chrome.cookies.getAll(pep) → IS_LOGIN + JSESSIONID
                → POST { cookie } to <ERP>/api/v1/uniware/session
```

Extensions can read `HttpOnly` cookies (`JSESSIONID` is one) through the
`chrome.cookies` API — the one context that can, which is why this works where a
page script cannot.

### The store endpoint  (`app/api/v1/uniware/session/route.ts`)

**Self-validating auth, no shared secret in the extension.** The endpoint proves
the caller holds a real Uniware session by *using* the cookie before storing it:

```
POST /api/v1/uniware/session   { cookie }
  → mint a token with THIS cookie against a throwaway healthcheck identifier
      (mint succeeds for any identifier, even nonexistent — verified 2026-09-01)
  → successful:true ?  store in uniware_web_session   : 400 "cookie not valid"
```

So possessing a working Uniware cookie *is* the authorization — someone without
Uniware access cannot produce one that mints. HTTPS-only, and rate-limited
through the existing `lib/gateway/rate-limit.ts`.

> Why not gate it on the ERP login instead: a `fetch` from a `chrome-extension://`
> origin is cross-site, and NextAuth's session cookie is `SameSite=Lax`, so it
> would not ride along on the POST. The self-validating check is both simpler and
> a tighter guarantee — it confirms the cookie actually works, not merely that
> some ERP user sent it.

### End-to-end flows

**Refresh** (anyone with Uniware access, ~every 10 h): open Uniware → click the
extension icon → "✓ Session updated". Nothing else.

**Push** (automatic): the desk adds an invoice exactly as today; the `docs` step
uploads the invoice PDF to the Uniware PO using the stored cookie. Stale cookie →
step `skipped`, invoice still commits, retried on the next Sync.

**Pull + view**: anyone clicks **Sync Documents** on the Invoices tab → new
documents land in S3 and appear in the invoice row → opened via `/files/presign`,
governed by ERP scope. Viewing needs no Uniware access; refreshing the session
does.

| Person | Does | Needs Uniware login | Needs the extension |
|---|---|---|---|
| Session-keeper (any Uniware user) | clicks the icon when Sync says "expired" | yes (their own) | yes |
| Desk operator | adds invoices, clicks Sync | no | no |
| Anyone viewing | opens a document | no | no |

The extension is needed only by whoever refreshes the session — one or two
people. Most users never touch it.

### Distribution — how others install it

| Path | For | How |
|---|---|---|
| **Load unpacked** | you, now | `chrome://extensions` → Developer mode → "Load unpacked" → pick the folder |
| **Chrome Enterprise policy** | the team, later | IT force-installs it by ID via `ExtensionInstallForcelist` in Google Admin / Windows registry — appears automatically, no user action, updates centrally |
| **Packed `.crx`** | a stopgap | share a signed `.crx`; each user drags it into `chrome://extensions`. Chrome resists side-loading, so this is fragile — the policy path is the real answer |

For a company Chrome fleet the enterprise policy is the clean route: publish the
folder to an internal URL (or the Web Store as **unlisted**), then force-install
by extension ID. Nobody clicks "Load unpacked" but you.

### Security surface — the one thing to get right

The cookie is a live login in flight. Therefore: the store endpoint is
**HTTPS-only**, **rate-limited**, and **validates before storing**; the cookie is
**never logged, never returned to any client, never echoed**; and the extension's
`host_permissions` are pinned to exactly `pep.unicommerce.com` and the ERP origin,
nothing broader.

---

## Build order

| # | Delivers | Files | Testable alone |
|---|---|---|---|
| 1 | Schema | `prisma/add_uniware_documents.sql` ✅ on dev | run on dev |
| 2 | SQL + session | `lib/queries/uniware-documents.ts` ✅, `web-session.ts` ✅ | — |
| 3 | Client | `lib/uniware/document.ts` ✅ proven (mint→list→download) | yes |
| 4a | Extension | `uniware_session_extension/` | load unpacked, reads cookies |
| 4b | Store endpoint | `app/api/v1/uniware/session/route.ts` | yes — self-validating mint |
| 5 | Sweep + button | `document-sync.ts`, `uniware-documents/route.ts`, `KEY_OWNER_SELECTS` | yes |
| 6 | Push step | one block in `invoice-inward.ts` | needs 3+4 |
| 7 | UI | attachments in the invoice expansion, "Sync Documents" button | needs 5 |

Steps 1–3 stand alone and prove the whole pipeline before anything touches the
invoice flow or the UI.

---

## Risks

| Risk | Mitigation |
|---|---|
| Cookie expires mid-day; pushes silently stop | Non-fatal step reports `skipped`; button reports `sessionStale`; surface it, never a silent zero |
| A 200 + SPA shell read as success | One shared "parsed as JSON with successful:true" check, in `mintCapability` |
| Cookie / token leak | Never logged, never returned to the browser, never in a client-visible URL |
| Pull re-downloads our own push | `source` column + filename skip |
| A real facility touched before we're ready | Every sweep filters to `TEST_FACILITY`; the push step is a no-op off it |
| Playwright bloats the prod image | It is a devDependency, dynamic-imported only in the dev connect route, never bundled |
| 2 MB upload ceiling (`maxFileSize=2`) | Check before pushing; a larger invoice reports `skipped`, not a failed commit |

## Open

1. **Cookie refresh: A, B, or both?** (see above — my recommendation: A now.)
2. **Push the PO PDF too**, or only the supplier invoice? Same mechanism.
3. **Backfill** signed copies already sitting in Uniware, or start from now?
