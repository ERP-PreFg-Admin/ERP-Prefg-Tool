# Uniware PO documents — both directions

**Goal.** Two things, one mechanism:

- **Push** — when an invoice is inwarded, the supplier invoice PDF lands on the
  Uniware PO, so the warehouse sees it while receiving.
- **Pull** — a button fetches whatever the warehouse attached (the signed copy
  above all) into our S3, readable from the ERP beside the invoice.

There is no warehouse-side app, so Uniware is the shared surface. This makes it
one.

---

## What was measured (2026-09-01)

Everything below was run against prod, not inferred. This replaces the earlier
Gate section — all four of its questions are answered.

### The document API is a real API, and it is plain HTTP

```
POST pep.unicommerce.com/data/document/auth/details/get     ← MINT (needs cookie)
     {"identifier":"PO-HLPL/2627/5663"}
  → {"successful":true,"token":"…","checksum":"…",
     "url":"https://docs.unicommerce.com","identifier":"PO-HLPL/2627/5663-pep"}

GET  docs.unicommerce.com/documents/list?identifier&token&checksum&username
GET  docs.unicommerce.com/document/V2/download?…&filename=   → {preSignedDownloadUrl}
GET  docs.unicommerce.com/document/V2/upload?…&filename=     → {preSignedUploadUrl}
PUT  <preSignedUploadUrl>                                     ← the bytes
POST docs.unicommerce.com/document/V2/acknowledge/upload?…&filename=
GET  <preSigned…Url>                                          ← S3, no auth at all
```

**Only the mint needs credentials.** Everything on `docs.unicommerce.com` is
authorised by `token` + `checksum` alone — no cookie, no bearer. Proven upload
end-to-end with nothing but a minted pair:

```
[1] mint         successful          [3] PUT to S3     200
[2] preSignedUploadUrl issued        [4] acknowledge   {"successful":true}
[5] list         [{"fileName":"erp-selftest.pdf","uploadedBy":"erp.prefg@…"}]
```

### The mint endpoint's three surprising properties

| Property | Evidence | Why it matters |
|---|---|---|
| **Cookie, not bearer** | bearer → `500` + SPA shell; anonymous → `401 USER_NOT_LOGGED_IN`; cookie → `200` | Our OAuth credentials cannot mint. This is the whole constraint. |
| **No page load needed** | plain `fetch` with `IS_LOGIN` + `JSESSIONID` mints fine | One cheap POST per PO, not a 10-second Playwright page render. |
| **No facility, no existence check** | minted happily for `PO-NO/SUCH/PO/9999` | No facility switching. And a token can be minted the instant we create a PO. |

The identifier is just a namespace key: `PO-<uniwarePoCode>`, tenant suffix
added server-side.

### Tokens are permanent; the cookie is not

- **Token pairs never expire** — one issued hours earlier still worked. They are
  also per-identifier: a pair for one PO is rejected for another.
- **The tenant session lasts ~10 hours.** `KEYCLOAK_SESSION` on a fresh login
  expired the same evening; a session saved the previous day was bounced to
  Keycloak.
- **Renewing it needs a human.** Tenant `pep` authenticates through Keycloak
  realm `google_only` — the login page has no form and no inputs. Google SSO
  with 2FA. Playwright cannot and should not automate that.

> **`token` and `checksum` are bearer credentials.** Anyone holding a pair can
> read and *write* documents on that identifier with no authentication. Never
> log them, never put them in a browser-visible URL, never return them from an
> API route.

---

## The design that follows

**Push is inline; pull is a button. Both are plain `fetch` from Next.js. The
only browser in the system is a human logging in once a day.**

```
Invoice commit (existing)                   Pull button (new)
  s3      store the PDF                       for each invoice with a Uniware PO:
  po      raise inward POs                      mint → list
  uniware mirror as one PO                      any filename we don't hold?
  docs    ← NEW: mint → upload the PDF            download → our S3 → attachments_invoice
  email   notify the warehouse
```

Documents hang off the **invoice**, not the PO: `invoice-inward.ts` mirrors one
Uniware PO per invoice, so `invoice_mfg.uniware_po_code` is the identifier and
`invoice_id` is the natural key. Inward POs are per-SKU children of that one
Uniware PO and share its document list.

### The cookie

One row, refreshed by a human roughly daily:

```
uniware_web_session
  id, cookie TEXT, obtained_at DATETIME, expires_at DATETIME NULL, obtained_by
```

`uniware_documents/harvest.py login` already opens a headed browser and saves
the session. It gains one step: **write the cookie straight to the DB.** The
laptop already reaches RDS (this investigation queried prod from it), so no
admin screen, no API route, no cookie travelling by copy-paste.

`getUniwareWebCookie()` reads the row. A stale cookie is detected by
**content, never status** — these routes answer `200` with an HTML shell rather
than `401`, so the check is "did the body parse as JSON with `successful:true`".
Same trap as `fetchPurchaseOrderPdf`'s `%PDF-` guard.

### Push must never break an invoice commit

`INWARD_STEPS` is ordered least-reversible-last for a reason. The new `docs`
step goes **after `uniware`, before `email`**, and is **non-fatal**: a stale
cookie makes it report `skipped`, not fail the invoice. The invoice is already
committed and the POs are already raised — refusing the whole thing because a
convenience attachment didn't land would be strictly worse.

A skipped push is picked up by the same button that does the pull. That is why
it is one button and not two: **it reconciles both directions** for every
invoice that is out of sync.

### Storage

```
attachments_invoice
  id, invoice_id INT INDEX, filename VARCHAR(255),
  s3_key VARCHAR(512), content_type, bytes INT,
  source ENUM('erp','uniware'),          -- who put it there
  uniware_uploaded_by, uniware_created_at DATETIME NULL,
  synced_at DATETIME,
  UNIQUE (invoice_id, filename)
```

`source` is load-bearing, not bookkeeping: without it the next pull re-downloads
the invoice PDF **we** pushed and stores a second copy of a file already in S3.
The pull skips `source='erp'` filenames.

**Non-optional:** add `attachments_invoice` to `KEY_OWNER_SELECTS` in
`lib/queries/s3-files.ts`, joined to `invoice_mfg` for `mfg_id`. That is the
guard deciding whether a key may be presigned; without it the file is
unopenable, and it is what keeps the document inside entity scope.

---

## Build order

| # | Delivers | Files |
|---|---|---|
| 1 | Schema | `prisma/add_uniware_documents.sql` — the two tables above |
| 2 | Client | `lib/uniware/documents.ts` — `mintCapability`, `listDocuments`, `uploadDocument`, `downloadDocument`. Plain fetch. |
| 3 | Cookie | `lib/uniware/web-session.ts` + the `harvest.py login` DB write |
| 4 | Push | one `docs` step in `lib/invoice/invoice-inward.ts` |
| 5 | Pull | `lib/uniware/document-sync.ts` + `app/api/v1/purchase-orders/uniware-documents/route.ts` |
| 6 | UI | button beside the existing sync buttons; documents listed in the invoice expansion |

Steps 1–2 are testable immediately; 4 needs 3.

---

## Risks

| Risk | Mitigation |
|---|---|
| Cookie expires mid-day; pushes silently stop | Non-fatal step reports `skipped` with the reason; the button reconciles; surface "session stale" in the sync summary so it is visible, not silent |
| A 200 + SPA shell read as success | One shared "did this parse as JSON with successful:true" check. Content, never status |
| `token`/`checksum` leak | Never logged, never returned to the browser, never in a URL the client sees |
| Pull re-downloads our own push | `source` column + filename skip |
| Uniware moves the mint endpoint | It throws rather than returning empty, and the sync reports per invoice — same discipline as `grn-map.ts` |
| 2 MB upload ceiling (`maxFileSize=2`) | Check before pushing; a larger invoice reports `skipped`, not a failed commit |
| Someone automates the Google login | Don't. It risks locking a real Workspace account, and the manual step is ~30s a day |

## Open

1. **Which invoices does the button sweep** — the visible page, or everything
   with a Uniware PO and no signed copy yet? Governs cost.
2. **Push the PO PDF too**, or only the supplier invoice? Mechanism is identical;
   it is a volume decision.
3. **Backfill** — POs already inwarded have signed copies sitting in Uniware
   today. One-off sweep, or leave history alone?
