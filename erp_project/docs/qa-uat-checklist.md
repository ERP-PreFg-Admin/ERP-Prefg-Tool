# Manual QA / UAT Checklist

> Run before a release. Everything here is deliberately **not** automated: it needs a browser, a real Google account, a real PDF, or a third-party service. The automated half (`npm test`, `npm run test:db`, `npm run test:checks`) covers the money and permission logic — don't re-test that by hand.

**Setup:** `npm run dev`, `APP_ENV` unset so you are on the **test** schema (`DB_NAME_TEST`). You need at least two accounts: one `developer`/`admin`, and one ordinary account you can scope down. Record the date, the commit SHA, and who ran it.

Legend: **P** = pass · **F** = fail (open a ticket and link it) · **N/A** = not applicable this release.

---

## 1. Authentication

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 1.1 | Sign in with a Google account that has **no** `users` row | Refused → `/auth/error`. No account is auto-created. | | |
| 1.2 | Set a user's `status` to `inactive` in `/admin`, then have them sign in | Refused. An already-signed-in session is not silently extended after the next sign-in attempt. | | |
| 1.3 | Create a user in `/admin` with a **mixed-case** email, then sign in with it | Works — the email is lowercased on insert | | |
| 1.4 | Create a user and sign in as them immediately | Works with no invitation email — the row *is* the whitelist | | |
| 1.5 | Sign out, then press the browser Back button | Not signed in; redirected to `/auth/signin` | | |
| 1.6 | Sign in, then check `sessions` and `session_history` | One active `sessions` row; a `login` row in `session_history` | | |

## 2. Page permissions

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 2.1 | Sign in as a user holding **no roles** | Signs in successfully but reaches nothing; the Users tab flags them with a warning | | |
| 2.2 | Grant `viewer` on `/masters`, reload | Masters pages open; every create/edit/upload control is absent or disabled | | |
| 2.3 | Grant `editor`, reload | Controls appear | | |
| 2.4 | Set a page to **None** (explicit block) and type its URL directly | Redirected to `/auth/unauthorized` — not a blank page, not a crash | | |
| 2.5 | Set a page to **Inherit** where the parent grants access | Access follows the parent | | |
| 2.6 | Grant `/masters` = viewer, `/masters/vendors` = editor via **role**, and set a **user override** of viewer on `/masters` | Vendors is still editable — **depth beats layer**, which surprises people. The Permissions tab's "resolved effect" column must agree with what actually happens. | | |
| 2.7 | Confirm the sidebar for a restricted user | Pages they cannot open are locked/hidden; no dead links | | |
| 2.8 | As the only admin, try to set your own `/admin` access below Editor | Refused with the self-lockout message | | |
| 2.9 | Try the same via the **role** grid for a role you hold | Also refused | | |

## 3. Data scoping (`/admin/data-access`)

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 3.1 | Leave a user unscoped | They see **every** manufacturer/vendor/warehouse — absence of rows means unrestricted | | |
| 3.2 | Scope them to one manufacturer | Manufacturers list, PO table, MFG Cost Manager and the sidebar's manufacturer list all show only that one | | |
| 3.3 | Export a scoped list to CSV/Excel | The export contains the same rows as the screen — no wider | | |
| 3.4 | Note a PO id belonging to an out-of-scope manufacturer, open `/api/purchase-orders/<id>` directly | `403 out_of_scope` | | |
| 3.5 | Same for receive / cancel / split / send-mail / preview-pdf on that id | All `403` | | |
| 3.6 | Try to change **your own** data access | Refused (self-scope guard) | | |
| 3.7 | Switch a section to "Only selected" with nothing selected and save | Refused — that would mean no data at all | | |
| 3.8 | Clear a scope back to "All" | Rows are deleted and the user sees everything again | | |
| 3.9 | Scope by **warehouse**, then check the PO list | Filtering works even though `destination` stores a name, not an id | | |
| 3.10 | ⚠️ Take an `attachment_key` from an out-of-scope PO and call `/api/files/presign?key=…&view=1` | **Currently returns a working URL — known HIGH finding, audit #5.** Confirm whether it has been fixed this release. | | |

## 4. Approval flow

Run for at least two modules (one master, one rate) plus one bulk upload.

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 4.1 | Edit a master record and submit | Record locks: blue "under review" banner, fields disabled, Save hidden | | |
| 4.2 | Try to submit with the remarks box empty | Blocked — remarks are mandatory | | |
| 4.3 | Try to edit the same record again from another account | Blocked while an approval is pending (`hasPending`) | | |
| 4.4 | Open `/approvals` as a Head | The item appears, grouped under its module, in the correct **New** / **Edits** / **Bulk Uploads** section | | |
| 4.5 | Expand it | Field-level old → new diff, with the submitter's remarks and who raised it | | |
| 4.6 | Approve | Value applied to the live record; status back to `active`; a toast confirms | | |
| 4.7 | Check the record's History dialog | The change is listed with submitter, approver and timestamp | | |
| 4.8 | Submit another edit and **reject** it with remarks | Status `rejected`; amber banner with the reason | | |
| 4.9 | Try to re-edit the rejected record as a **different** user | Blocked — only the original submitter may re-edit | | |
| 4.10 | Re-edit as the original submitter | Allowed; goes back to `in_review` | | |
| 4.11 | Reject with an **empty** remarks box | Blocked — remarks are mandatory on rejection | | |
| 4.12 | Approve a rate change, then open Rate History | The superseded rate is listed **with who changed it and why** | | |
| 4.13 | ⚠️ For a **manufacturer** rate, check the archived row's end date | **Currently blank — known finding, audit #4.** Vendor rates do show it. | | |
| 4.14 | Upload a bulk CSV, then open the approval | One approval for the whole file; the CSV renders as a **table** (not a raw download) | | |
| 4.15 | Include a row whose code matches an existing record | It is treated as an **edit** requiring remarks, not blocked as a duplicate; it becomes its own single-entity approval | | |
| 4.16 | Approve the bulk batch | Every valid row is inserted; the count matches the preview | | |
| 4.17 | Approve as a user **without** `/approvals` editor | The approve/reject buttons are absent, and the API refuses | | |

## 5. PO lifecycle

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 5.1 | Raise an impromptu PO | Goes through approval; on approval status becomes `raised` and the manufacturer email sends | | |
| 5.2 | Receive part of the quantity | Shows as `partially_received`; the progress cell reflects the split | | |
| 5.3 | Receive the remainder | `received` | | |
| 5.4 | On a 1000-unit PO, receive 901 | **Auto-closes to `received`** even though 99 never arrived (10% tolerance, capped at 100). Confirm this is still the intended policy. | | |
| 5.5 | Try to receive more than outstanding | Refused with a clear message; `received_qty` unchanged | | |
| 5.6 | Try to receive against a `cancelled` PO | Refused (409) | | |
| 5.7 | Split a PO across two manufacturers | Two children created, parent quantity reduced by exactly the split total | | |
| 5.8 | ⚠️ Split the **same** PO a second time | **Currently fails with a duplicate-key 500 — known HIGH finding, audit #1.** Confirm whether fixed. | | |
| 5.9 | ⚠️ Split a PO with no unit price | **`total_amount` currently becomes 0 — known finding, audit #2.** | | |
| 5.10 | ⚠️ On a 1000/950-received PO, split off the last 50 | **Parent currently stays `raised` forever — known finding, audit #3.** | | |
| 5.11 | Split a **draft** PO | Children are `draft` and each raises its own approval with the 7-field diff | | |
| 5.12 | Cancel a PO | `cancelled`; no further receipts possible | | |
| 5.13 | Short-close a PO with a large remainder | `short_closed`; reason recorded | | |
| 5.14 | Preview the PO PDF | Branded A4 renders with correct quantities and rates | | |
| 5.15 | Send the PO email | Arrives with the PDF attached; `email_sent_at` is stamped | | |
| 5.16 | Filter/sort/paginate the PO table, then use browser Back | State is in the URL and restores correctly | | |

## 6. Invoice inwarding

The least-covered flow — external services, long-running, and it books stock. Test it properly.

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 6.1 | Upload a real supplier invoice PDF | Parses in ~50–70s; the UI says it will take that long rather than looking hung | | |
| 6.2 | Check the parsed header | Invoice no, date, e-way bill, vehicle, currency, both GSTINs, bill-to/ship-to, total all populated | | |
| 6.3 | Check the mapped manufacturer / warehouse / SKUs | Fuzzy-matched and pre-filled; every one is **overridable** | | |
| 6.4 | Override a wrongly-mapped SKU | The override is what gets committed, not the guess | | |
| 6.5 | Upload a non-PDF, an empty file, and a >10 MB file | Each rejected with a specific message | | |
| 6.6 | Upload an unreadable scan | `422` "no invoice fields could be read" — not a blank form | | |
| 6.7 | Close the tab mid-review, then reopen Add Invoice | The draft (**including the PDF**) is offered back from IndexedDB; no re-parse needed | | |
| 6.8 | Abandon a review without submitting, then check S3 | **No orphaned object** — nothing is stored until submit | | |
| 6.9 | Submit and watch the step stream | Four steps report in order: stored → POs created → Uniware → warehouse notified | | |
| 6.10 | Check the results | One inward PO per line (`po_type = 'inward'`), `expected_on` = the **invoice date** (backdated), `supplier_invoices` + `supplier_invoice_items` written | | |
| 6.11 | **Submit the same invoice again** | Refused by `UNIQUE (mfg_id, invoice_no)`. Critically: `received_qty` on any referenced PO is **not** credited twice. | | |
| 6.12 | On a line, pick an existing open PO as Reference PO | That PO's `received_qty` is credited **and** the line still raises its own inward PO (`link_type = 'received'`, both PO links stored) | | |
| 6.13 | Reference a PO belonging to an out-of-scope manufacturer | Not offered in the picker; refused if forced | | |
| 6.14 | Map a line to an `inactive`/`discontinued` SKU | Refused with a message naming the SKU and its status | | |
| 6.15 | Unset the `UNIWARE_*` vars and submit | Uniware step reports **skipped**; the invoice still commits | | |
| 6.16 | Submit for a warehouse with **no** `entity_emails` row | Mail step reports skipped; the invoice still commits (goods are physically here) | | |
| 6.17 | Check the warehouse email | Correct subject; the original invoice PDF attached; the Uniware PO document attached when available; a SKU summary in the body; signed with the filer's name | | |
| 6.18 | Check the Uniware PO code | Stored on `supplier_invoices` **and** on every inward PO from that invoice | | |
| 6.19 | Open the Invoice History dialog and expand a row | Header, line items, and both PO links per line | | |
| 6.20 | Force a failure (e.g. bad Uniware credentials) | The failure is reported as a step event; the DB is rolled back and the S3 object removed — **no half-committed invoice** | | |

## 7. Admin panel

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 7.1 | Create a user with a duplicate email | `409` with a readable message in the dialog | | |
| 7.2 | Edit a user | Email is read-only; name/status/roles editable | | |
| 7.3 | Assign several roles across domains | All persist; designation and domain chips are derived correctly | | |
| 7.4 | Look for a delete button | There isn't one — deactivation is `status = inactive` | | |
| 7.5 | Check the Activity tab after doing some edits | Your `POST`/`PATCH`/`PUT`/`DELETE` requests are listed with path, status, duration and IP | | |
| 7.6 | Just browse a few pages, then check Activity | **No** rows for those page loads — GETs are deliberately skipped | | |
| 7.7 | Filter Activity by user / method / path / date range, and paginate | Filters are URL-driven and applied in SQL | | |
| 7.8 | Confirm logins appear | Sign-in/sign-out events are on the same timeline (from `session_history`) | | |
| 7.9 | Check a request that failed (e.g. a rejected edit) | The row records the real `4xx`/`5xx` status | | |

## 8. Masters and BOM

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 8.1 | Create one record in each master | Succeeds; codes auto-generate where applicable | | |
| 8.2 | Search and filter each master list | Server-side, URL-driven, paginated | | |
| 8.3 | Sort by several columns | Sort is applied in SQL, not just the visible page | | |
| 8.4 | Add a second MOQ slab for a vendor/material already priced | A **new row**, not an update | | |
| 8.5 | Open a rate-comparison dialog | Cheapest/most-expensive vendor rates shown correctly | | |
| 8.6 | Create a new BOM version changing **only** RM lines | `bom_code` bumps the **RM** number only (`<sku>RM2PM1`) | | |
| 8.7 | Create a version changing only PM lines | Only the PM number bumps | | |
| 8.8 | Re-save a BOM with lines in a different order | **No** version bump — order is not a change | | |
| 8.9 | Check RM line amounts round-trip | A formulation percentage isn't rounded away (`details_bom.amount` is `DECIMAL(12,4)`) | | |
| 8.10 | Download a bulk template, upload it with 2 valid and 2 invalid rows | Invalid rows flagged with reasons and downloadable; only valid rows stage | | |

## 9. Manufacturing cost manager

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 9.1 | Open a manufacturer's page | Seven tabs; the SKUs tab shows active/discontinued/inactive counts | | |
| 9.2 | Check a SKU's Agreed Final Costing against a hand calculation | RM = % of fill weight priced per kg; PM per unit; wastage applied **per side**; JW + shrink + shipper added | | |
| 9.3 | Export Agreed Final Costing | Matches the screen exactly | | |
| 9.4 | Export the Detailed Breakup (Negotiation) as xlsx | Two sheets; csv gives the Summary sheet only | | |
| 9.5 | Change a line's status to `inactive` | No new POs can be raised against it | | |
| 9.6 | Open the Common RMs and Vendor Ing Mapping tabs | Honest "coming soon" placeholders, not errors | | |
| 9.7 | Open a manufacturer outside your scope by URL | Redirected to `/auth/unauthorized` | | |

## 10. Cross-cutting

| # | Steps | Expected | P/F | Notes |
|---|-------|----------|-----|-------|
| 10.1 | Toggle dark mode and walk every module | No unreadable text, no white-on-white panels | | |
| 10.2 | View a list with **zero** rows after filtering | A proper empty state, not a broken table | | |
| 10.3 | Set page size to 100 on the biggest list | Loads in reasonable time; pagination bar is correct | | |
| 10.4 | Narrow the window / use a laptop screen | Wide tables scroll inside their own container; the page doesn't scroll sideways | | |
| 10.5 | Open a record with very long free text (name, INCI name) | Truncated in the cell, full text on click | | |
| 10.6 | Double-click a submit button | No duplicate record / duplicate approval | | |
| 10.7 | Leave a page mid-load and come back | No stale data, no unhandled error toast | | |
| 10.8 | Check the browser console across a full pass | No uncaught errors | | |
| 10.9 | Check `logs/error-YYYY-MM-DD.log` afterwards | Nothing unexpected; anything present has a `requestId` you can trace | | |

---

## Sign-off

| | |
|---|---|
| Release / commit | |
| Tested by | |
| Date | |
| Automated suites | `npm test` ⬜ `npm run test:db` ⬜ `npm run test:checks -- --db` ⬜ `npm run build` ⬜ |
| Rows marked ⚠️ | These are **known open defects** from [qa-audit-2026-08.md](./qa-audit-2026-08.md). Confirm each is either fixed or accepted for this release. |
| Blocking failures | |
| Accepted with tickets | |
