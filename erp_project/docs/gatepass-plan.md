# GatePass — shipping-package-type summary per facility

**Status: BUILT, 2026-08-28.** All five phases shipped; both gates passed against
production. One manual step remains — see §8.

| | |
|---|---|
| `lib/gatepass/facilities.ts` | the 20 codes, verbatim, + `isKnownFacility` |
| `lib/gatepass/summary.ts` | pure: `istDayRangeMs`, `istDaysBack`, `summarise` |
| `lib/gatepass/fetch.ts` | one facility → export job → counts; never throws for a business failure |
| `lib/validation/gatepass.ts` | Zod, with the facility roster as the guard |
| `app/api/v1/gatepass/summary/route.ts` | one facility per request, NDJSON |
| `app/gatepass/{page,GatepassClient}.tsx` | the screen |
| `prisma/add_gatepass_page.sql` | **not yet applied** |
| `tests/unit/gatepass-summary.test.ts` | 9 tests, your `selftest()` ported |
| `lib/uniware/export-jobs.ts` | `exportFilters` param + `SALE_ORDER_EXPORT` |

Verified end to end: `mCaff_Ahmedabad`, 2026-08-27 → 1,141 export rows collapse to
**423 distinct orders over 5 package types**, 0 shared. `npm test` 526/526,
`npx tsc --noEmit --incremental false` clean, `npm run build` clean.

A new sidebar tab, `/gatepass`. One question, answered live: *for this IST day, at
this facility, how many distinct orders sit under each shipping package type?* That
count is what a gatepass is written against. Facility-wise by default, with an
all-facility option.

**Nothing is stored, and nothing is read from our DB.** No table, no migration, no
query. The facility list is a constant ported from the script; the export exists as
a string inside one request and is dropped when it returns — the same posture as
`lib/mfg-facility-sync.ts`, and the only kind of cleanup that can't be forgotten.

---

## 1. What already exists, and is therefore not being written

The Python script is a standalone re-implementation of a pipeline this repo already
runs in production. The port is mostly deletion.

| Script does | Repo already has | Gap |
|---|---|---|
| `Token`, `_login`, refresh-on-expiry | `lib/uniware/auth.ts` — `getToken()`, cached, refreshed, in-flight collapse | none |
| `export_rows`: job create → poll → download CSV | `lib/uniware/export-jobs.ts` — `createExportJob` / `pollExportJob` / `downloadExportCsv` | **`exportFilters` is hardcoded `[]`** |
| `pd.read_csv` | `lib/csv.ts` — `parseCsvObjects`, RFC 4180 | none |
| looping 20 facilities in one process | `app/api/v1/manufacturing/facility-map/sync/route.ts` — one facility per request, NDJSON progress, browser is the scheduler | none — copy the shape |
| `--csv` to Downloads | client-side Blob download | none |
| `--selftest` | `tests/unit/*.test.ts` via `node:test` | none |

So the real new code is: **one optional parameter**, **one pure summariser**, **one
route**, **one page**, **two nav lines**.

Two things in the script are deliberately *not* ported:

- **Hardcoded credentials** (`erp.prefg@mcaffeine.com` / `Admin@erpprefg` as
  `os.getenv` defaults). Env only, no default. If that is a second Uniware login
  distinct from `UNIWARE_USER_NAME`, that is gate 0.1 below, not a fallback.
- **The `DOWNLOADS` path.** A server writing to `C:\Users\AJAY SINGH\...` is a
  desktop-script assumption; the browser owns the download.

**Facilities: your list, verbatim.** `lib/gatepass/facilities.ts` holds the 20 codes
and `DEFAULT_FACILITY = "mCaff_Ahmedabad"` exactly as the script has them. No
`details_warehouse_entity` read, no join, no scope query. One consequence, stated
plainly rather than buried: this list and Warehouse Master can drift, and nothing
will notice. That is the accepted trade for v1 — a comment on the constant names the
upgrade path.

---

## 2. The business rule — the only part worth a test

Everything else is transport. This is the logic:

1. The export repeats an order **once per line item**. Deduplicate
   `(package_type, order_code)` pairs *before* counting, or every multi-line order
   inflates its package type.
2. `orders` = distinct order codes per package type.
3. `shared_orders` = orders appearing under **more than one** package type. Such an
   order cannot go on a single gatepass. Surfaced on both types, never hidden. The
   script notes this is 0 in every export seen so far — which is exactly why it must
   be visible when it stops being 0.
4. A **renamed or absent column fails loudly**. Silent-zero is a documented failure
   mode in this codebase (`bom_misc`); a summary reporting "0 orders" because a
   header changed is worse than one that refuses.
5. The IST day window is `[00:00:00.000, 23:59:59.999]` in epoch millis, +05:30.

`tests/unit/gatepass-summary.test.ts` ports the script's `selftest()` assertions
verbatim, including the epoch pin `ist_day_range_ms(2026-08-24) == {1787509800000,
1787596199999}`. Pure module, no credentials, runs in CI.

---

## 3. Gates — verify before building

Facts I cannot confirm from the code. Building past a wrong answer wastes the phase
after it.

**0.1 — Same tenant, same permissions?**
The script hits `https://pep.unicommerce.com` as `erp.prefg@mcaffeine.com`. Confirm
`UNIWARE_BASE_URL` is that tenant and that `UNIWARE_USER_NAME` may create a **"Sale
Orders"** export job. Export-job type access is per account. A different login means
either an env addition or a permission change on the existing account — decide which
before Phase 3.

**0.2 — Header spellings.**
Uniware returns **display names, not the keys requested** — documented in
`mfg-facility-sync.ts`'s `COLS`. The script assumes `"Shipping Package Type"` and
`"Display Order Code"`. Confirm against one real export, and accept a small alias
list per column the same way `COLS` does.

**0.3 — Is `invoicedOn` the right day boundary?**
The gatepass is about what physically leaves. If dispatch date and invoice date
diverge at any facility, this report answers a slightly different question than the
desk is asking. Your call.

> **Gate:** no UI until one facility returns a real, non-empty summary against
> production. Phases 1–2 are cheap; Phases 3–5 are wasted if 0.1 fails.

---

## 4. Sequencing

**Phase 1 — the filter parameter.** Add a fourth optional arg to `createExportJob`
(`filters: unknown[] = []`) passed through to the body's `exportFilters`. Existing
callers unchanged. ~2 lines.

**Phase 2 — `lib/gatepass/summary.ts`, pure.** `istDayRangeMs(day)` and
`summarise(csv, facility)`. No DB, no fetch, no env — so it is unit-testable without
credentials, the same reason `lib/po-split.ts` and `lib/uniware/errors.ts` are
carved out. Then `fetchFacilitySummary(facilityCode, window, emit?)` alongside it —
the impure create/poll/download/summarise wrapper, mirroring `syncFacility`, which
**never throws for a business failure**: one bad facility out of 20 must not kill the
other 19, so the result carries `{ facility, ok, rows, summary[], error?, fatal? }`.

**Phase 3 — `POST /api/v1/gatepass/summary`.** One facility per request, NDJSON step
stream, `maxDuration = 300`. Not a style choice: an export is an async job per
facility, 20 cannot fit in one 300s request, and there is no queue or worker in this
repo. The **browser is the scheduler**, exactly as the facility-map sync does it.
Status is always 200 once streaming starts; failures travel as events. The route
rejects any `facility_code` not in the constant list — the client sends a string, and
that list is now the only thing defining what a valid facility is.

**Phase 4 — access, before the page.** One row in `lib/pages.ts` (`/gatepass`), one
entry in `components/Sidebar.tsx`'s `NAV`, one seeded `page_permissions` row. Before
Phase 5, so the page is never briefly reachable by everyone.

**Phase 5 — the page.** `app/gatepass/page.tsx` — server component for the auth
guard and `resolveAccess` only; the facility list is an import, not a query. A client
child owns the day picker (the shared `components/ui/date-picker.tsx`, not a new
one), the facility multi-select, "All facilities", the sequential fetch loop with
per-facility progress, the table, and a client-side CSV download.

---

## 5. Governance and risk

**No entity scope on this screen.** Warehouse scope lives in `lib/scope.ts` and needs
a DB read to resolve a facility code to a warehouse name; you have ruled the DB out
for now. So `/gatepass` is gated by **page permission alone** — anyone who can open
it sees every facility. Fine if the audience is the dispatch/ops group; not fine if
it is granted broadly. Adding scope later is one query plus one `inScope` call, and
is the reason Phase 3 keeps facility validation server-side rather than trusting the
picker.

**All-facility is expensive and the UI must not hide it.** 20 sequential export jobs
× 10–60s each is **5–20 minutes of Uniware load per click**. Sequential, never
parallel — a 20-job burst is how an integration gets throttled. Progress is
per-facility and the run is interruptible. *Question: is a daily all-facility pull
acceptable to Unicommerce, or should it be capped / off-peak?*

**"Don't store" means every view re-pulls.** Two people asking about yesterday run 40
jobs. Accepted for v1 as instructed.
`ponytail: no cache; an in-memory Map keyed (facility, day) with a short TTL is ~5
lines if the re-pull cost bites.` It is per-process, so it stops helping the moment
there is more than one container.

**Sandbox pinning does not interfere.** `createExportJob` deliberately bypasses
`uniwareFacility()` — an export is a READ and must ask about the facility named, not
the sandbox one. Already pinned by `tests/unit/uniware-export.test.ts`; this feature
depends on it staying that way.

**Failure is per-facility.** A facility with no orders yesterday is a blank row, not
an error. A facility that 403s is one red row and nineteen good ones.

---

## 6. Deliberately not in scope

Creating, numbering, or printing gatepasses. Any DB table. Scheduled or emailed runs.
Per-order drilldown. Editing package types. Reconciling the facility constant against
Warehouse Master. Say the word and any becomes its own plan — none is implied by
"show me the summary".

---

## 7. Open questions

1. **Read-only forever, or step one toward creating gatepasses in the ERP?** If
   gatepasses will live here, the summary eventually needs identity and a stored
   number, and Phase 2's shape should anticipate that. If it is a report, it should
   not.
2. Gate 0.3 — `invoicedOn` vs a dispatch date.
3. Who gets `/gatepass`, and does it sit under **Production Tracking** in the sidebar
   or as its own top-level tab?

---

## 8. What is left to do by hand

**Apply `prisma/add_gatepass_page.sql` to both schemas.** Until it runs, `/gatepass`
is closed to *everyone* — it is a top-level slug, so `resolveAccess`'s parent-walk
has nothing to fall back to and returns `none` even for developers, and there is no
way to open it from /admin > Permissions because that grid can only edit a page you
can already reach. Same bootstrap problem the `/admin` rows in `add_activity_log.sql`
solved. Everyone beyond developer/admin is granted from the UI afterwards.

## 11. Round 3 — boxes, not SKUs (2026-08-28)

**A gatepass line is a shipping package type, and its quantity is boxes** —
distinct orders in that type. Package types *are* box types, so this is the count
the document exists for. The SKU-based lines from round 2 are deleted, not
flagged off: one facility-day went from 97 SKU lines / 3,503 units to **5 lines
totalling 423 boxes**, which is a gatepass rather than a picking list. Restoring
the SKU path is `skuCode` back in `SALE_ORDER_COLUMNS` plus `COLS.sku_code`.

The wire field stays `itemSKU` and now carries a package type. That mismatch is
Unicommerce's field name, not ours, and it is part of what `buildGatepassPayload`
is flagged unverified for.

**`toParty` is `Dry_Inv_CWH_Consumption` for every facility.** ⚠️ That is the
exact string `sale_order_to_gatepass.py` uses as `TO_PARTY_UNSET`, commented
"never sent: --live refuses while this is the value". It is a real party name, so
that script's guard is inverted — it refuses precisely when configured correctly.
Here it is one constant and the blocker is a plain empty-check.

Verified live, `mCaff_Ahmedabad` 2026-08-27: 1,141 export rows → 423 orders →
5 lines / 423 boxes, prefix `M/AHM/OG/2627/`. **One blocker left**, the unverified
contract. `npm test` 544/544; typecheck, lint and build clean.

---

## 10. Round 2 — date range + gatepass dry run (2026-08-28)

**Column keys, settled by probe.** Uniware rejects an unknown export key outright
(`invalid column type`) and rejects an empty list for this report, so these could
not be guessed — they were enumerated:

| Accepted | Display header | Rejected |
|---|---|---|
| `skuCode` | Item SKU Code | `itemSKU`, `itemTypeSku`, `itemTypeCode` |
| `sellerSkuCode` | Seller SKU Code | |
| `saleOrderCode` | Sale Order Code | `invoicedOn` (a filter, not a column) |
| `invoiceCode` | Invoice Code | |
| `itemDetails` | Item Details (always blank) | |

**There is no quantity column.** `itemQuantity`, `quantity`, `orderedQuantity`,
`orderItemQuantity`, `saleOrderItemQuantity`, `qty`, `itemCount`,
`totalQuantity`, `shippedQuantity`, `itemTypeQuantity`, `packageQuantity` — all
rejected. The report is line-item grained instead (order `9318101` came back as
two identical rows for `MCaf370`), so **quantity is the row count per SKU**. Same
answer as the script's `else 1` branch, and it clears blocker #2.

**The range is one job.** `istRangeMs("2026-08-01","2026-08-27")` is pinned to
your exact payload — `{ start: 1785522600000, end: 1787855399999 }` — so a drift
in that arithmetic fails a test rather than silently covering different days.
Capped at 92 days (`MAX_RANGE_DAYS`), sized for CSV bulk and the 300s request
budget, not job count.

**Verified live**, `mCaff_Ahmedabad` 2026-08-25→27: 3,503 export rows → 1,292
orders over 5 package types, and a plan of 97 SKUs / 3,503 units carrying prefix
`M/AHM/OG/2627/`. Two blockers still fire (toParty, unverified contract).
`npm test` 543/543; typecheck, lint and build clean.

**Still open:** the create contract (yours), `TO_PARTY` (ships empty), and the
`CITY` vs `FACILITIES` mismatch — six selectable facilities have no city and plan
without a prefix rather than being given a guessed one.

---

## 9. What the gates actually returned (2026-08-28)

**0.1 — same tenant, same account, passes.** `UNIWARE_BASE_URL` is
`https://pep.unicommerce.com` and `UNIWARE_USER_NAME` is `erp.prefg@mcaffeine.com` —
the identical login the script uses, so no new credential and no permission change.
`HYP_AHMD` (558 rows) and `mCaff_Ahmedabad` (1,141 rows) both returned data on one
token, so the two legal entities share a tenant.

**0.2 — headers confirmed, with a catch worth keeping.** `"Shipping Package Type"`
and `"Display Order Code"` are exact. But the export returned **four columns, not
the two requested** — Uniware appended `Channel Shipping` and `Item Details` on its
own. Reading by header name rather than position is therefore load-bearing, not
defensive style, and `tests/unit/gatepass-summary.test.ts` pins it with a
column-reordered fixture.

**Found while building:** a loose `day.split("-")` parses `"24-08-2026"` as year 24
and returns a perfectly well-formed window around 24 AD. `istDayRangeMs` validates
strictly and round-trips the date, so `2026-02-30` fails instead of silently becoming
March 2nd. The unit test caught this, not review.

**0.3 — `invoicedOn` is still unanswered.** It is what the script filtered on and
what shipped. If dispatch date and invoice date diverge at any facility, this counts
the wrong day; changing it is one constant in `lib/gatepass/fetch.ts`.
