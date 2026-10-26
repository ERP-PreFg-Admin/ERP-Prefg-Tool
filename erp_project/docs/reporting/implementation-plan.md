# Reporting — implementation plan

**Status (2026-10-26):** awaiting Ajay's sign-off on these docs (T0). No code until then.
Companion docs: `data-inventory.md`, `analyst-use-cases.md`, `report-tab-design.md`, `independent-review.md`.

## Decisions (Ajay, 2026-10-26)

| Decision | Choice |
|---|---|
| Audience | Everyone |
| PO value | Pre-GST and GST-incl side by side; totals and sort on pre-GST; unpriced/special counted separately |
| Open PO | Mailed, not closed: display status ∈ raised/punched/partially_received, non-inward masters, open qty > 0 |
| Access | `/reports` **and** the report's source page, plus `getViewScope`; invoices scoped per line |
| Phase 1 | PO-01, PO-02, INV-01 + INV-02, DQ-01 |
| *Assumed* | XLSX and CSV via `lib/export.ts`; tables only; IST dates; 50k export cap |

## Current state (summary)
- `/reports` is a "Planned" slug only. No pages, no grant, no chart library, no summary tables.
- PO and invoice data are rich but full of traps (receipts stored twice, splits, a mixed `total_amount`, soft reverts). There is no inventory data at all.

## Metric definitions (canonical; implemented once in `lib/reports/definitions.ts` + `lib/queries/reports.ts`)

```
PO base set   = purchase_orders po
                WHERE COALESCE(po.po_type,'') <> 'inward'
                  AND NOT IS_SPLIT_CHILD            -- MASTERS_ONLY
                  AND status NOT IN ('draft','rejected')   -- APPROVED_ONLY
                + CHILD_AGG_JOIN
received      = RECEIVED_TOTAL_EXPR
open qty      = GREATEST(po.qty - received, 0)
is open       = DISPLAY_STATUS_EXPR IN ('raised','punched','partially_received') AND open qty > 0
price class   = special  if po_type IN ('npd','tech_transfer','cpr')
                unpriced if unit_price IS NULL OR unit_price = 0
                priced   otherwise
value pre-GST = priced ? COALESCE(amount_pre_gst, unit_price*qty) : NULL      -- never total_amount
open pre-GST  = priced ? open qty * unit_price : NULL
value incl GST= pre-GST * (1 + COALESCE(sk.gst,0)/100)
today         = IST date computed in TS, passed as a parameter (not CURDATE())
overdue       = is open AND expected_on < today
age days      = DATEDIFF(today, po.date)
invoice live  = invoice_mfg.reverted_at IS NULL
```

## Query and API design (Phase 1)

| Report | Statement(s) | Scope | Sort keys (whitelisted) |
|---|---|---|---|
| PO-01 | rows: base set + open filter + joins to `master_skus`/`master_mfgs`, LIMIT/OFFSET. Totals: same WHERE, SUMs | `scopeClause` on mfg, brand (`sk.brand_id`), warehouse (`destination`) | age, open qty, open pre-GST, expected_on, mfg |
| PO-02 | GROUP BY `m.code`, `DATE_FORMAT(po.date,'%Y-%m')` over the base set (not cancelled/reverted). Lead time: per-PO MIN(`invoice_mfg.created_at`) via `received_against_po_id`, live invoices, as a derived table; median/p90 in TS | same | month, mfg, fill % |
| INV-01 | rows built on `INVOICE_LIST_BODY` measures + `total_amount` sum of lines; leg states via `three-way.ts`; exception rows unioned in TS | mfg + destination + **brand per line** (line subquery `EXISTS … sk.brand_id IN (?)` and line sums restricted to scope) | invoice date, gap value |
| INV-02 | lines JOIN PO via `received_against_po_id`, priced POs only | brand per line, mfg | diff %, value at risk |
| DQ-01 | one COUNT + one LIMIT 200 list per check; checks run in parallel (`timedParallel`) | each check scoped on its entity; hidden without the source slug | — |

- **Page:** a server component calls `lib/services/reports/<id>.ts`.
- **Export:** `GET /api/v1/reports/[reportId]/export` → `withGateway({ access: { pageSlug: "/reports", level: "viewer" } })` → `assertReportAccess(sourcePageSlug)` → the same service with `{ limit: 50_000 }` → COUNT first, 413 above the cap → `exportResponse`.

## Indexes (justified on dev before proposing; dev-only DDL first)

**T2 outcome (2026-10-26, dev):**
- **`idx_po_reference_po`** was missing on dev as well as prod, despite `prisma/add_po_reference_po_index.sql` existing. Applied that existing file on **dev only**. EXPLAIN of PO-01: the `CHILD_AGG_JOIN` child scan went from `ALL` to `range` on the index. **Prod: pending its own go-ahead.**
- **`purchase_orders(po_type, status, date)` was dropped.** PO-01 filters on expressions (`DISPLAY_STATUS_EXPR`, `po_type <> 'inward'`) that no index serves. Dev (41 POs) can't show a benefit either.
- **`approvals(module, entity_id)`:** not needed, because no Phase 1 report reads approvals.
- **`invoice_items_mfg(received_against_po_id)`:** already exists (`idx_sii_received_against`).
- **Reconciliation R1 on dev data:** PO-01's open qty = 201,110 = FG PO Tracking's `summaryStats.open_qty`. Overdue POs match (4).

**PO-02 as built (2026-10-26):**
- **Ordered** = non-inward approved masters whose display status is not draft, cancelled or reverted (the same set as `summaryStats.committed_qty`).
- **Received** = `RECEIVED_TOTAL_EXPR`.
- **Closed short** = the gap on received or short_closed POs. **Still open** = the gap on open POs.
- **Lead time** = PO date → IST date of the first non-reverted invoice receipt, with split children rolled up to their master. Median and p90 are nearest-rank, computed in `lib/reports/fill-rate.ts`.
- **On time** = that first receipt lands on or before `expected_on`.
**T5 export as built (2026-10-26):**
- **Route:** `GET /api/v1/reports/[reportId]/export`. Access is `/reports`, then `assertReportAccess` for the source page.
- **Same rows as the screen:** the URL is parsed by `lib/reports/params.ts`, the same parser the pages now use, then passed to the same service. So E1 (file = screen) holds by construction.
- **Size limits:** 413 above 50k rows, or 5k invoices for INV-01. Data quality exports every row of the open check, or the counts when none is open.
- **Repo checks updated:**
  - The route is in the `route-scope.test.ts` EXEMPT map with its reason ([reportId] is a report, not a record).
  - It's documented in `docs/api/reports.md` and the census.
  - A `reports` module was added to `lib/observability/modules.ts`.
  - `tests/unit/report-export-columns.test.ts` pins every column key to the service row types.

**DQ-01 as built (2026-10-26):**
- **8 checks** in `lib/reports/dq-checks.ts`: unpriced POs, missing pre-GST amount, the total-flip signature, open POs with no valid destination, SKUs with GST 0 or blank, SKUs with no Supply Name, facility-map SKUs not in Uniware, and invoices never synced.
- **Plan change:** "map gaps" became "not in Uniware" (never pushed or seen, or a push error). The planned "no vendor code" check can't occur, because `un_mfg_code` is NOT NULL on every row.
- **Dropped:** invoice total-vs-lines, which is already INV-01's job.
- **Scope and access:** each check is scoped like its source page, and hidden without access to that page.
- **Dev run:** all 8 execute, and count = listed rows (cap 200) for every check: unpriced 9, no-GST SKUs 20, no Supply Name 68, not in Uniware 5, others 0.

**INV-01 / INV-02 as built (2026-10-26):**
- **INV-01 badges** come from `threeWayMatch()` on inputs mirroring `selectMatchFields`. Exceptions = variance, unmatched and invoice-matched (no GRN). Live invoices only. The date filter is the IST **inwarded** date, because `invoice_date` can be NULL. Rows are scanned up to 5,000 (the strip's cap), with a warning above it.
- **Brand scope (strict, a default to confirm):** INV-01 hides any invoice that has a branded line outside the viewer's brands, because its totals would include that brand's value. The invoice list/strip still uses "any line in scope". INV-02 scopes each line.
- **INV-02:** invoice line `rate` vs `purchase_orders.unit_price` via `received_against_po_id`, on priced POs only. Every other line lands in exactly one counted bucket: no PO / PO not found / unpriced-or-special.
- **R3 on dev data:** INV-01 badge counts equal the invoice strip's `summariseMatches` (7 invoices: 2 invoice-matched, 5 unmatched). Line accounting: 15 = 0 priced + 0 no PO + 11 PO not found (dangling ids on dev) + 4 unpriced.

- **R2 on dev data:** ordered 204,510 and received 2,400, equal to `summaryStats` committed and received for the same range. The first-receipt subquery scans the invoice tables in full, which is acceptable at their size; revisit if they grow into the tens of thousands.

## Tasks

| ID | Task | Depends | Files | Outcome | Verify |
|---|---|---|---|---|---|
| T0 | Sign off these 5 docs | — | `docs/reporting/*` | Approved scope | Ajay |
| T1 | Export the PO building blocks; add `lib/reports/definitions.ts` (price class, IST today, value labels) | T0 | `lib/queries/purchase-orders.ts` (export only), `lib/reports/definitions.ts`, `tests/unit/report-definitions.test.ts` | One definition of open/value | `npm test`; `tsc --incremental false` |
| T2 | Dev `EXPLAIN`s; `prisma/add_reports_indexes.sql` on **dev only** | T0 | `prisma/add_reports_indexes.sql`, `schema.prisma` | Indexes justified | before/after EXPLAIN in the SQL header. **Stop.** Prod needs a go-ahead |
| T3 | Nav, guard, registry, catalogue | T0 | `lib/pages.ts`, `components/Sidebar.tsx`, `app/reports/layout.tsx`, `app/reports/page.tsx`, `lib/reports/catalog.ts`, `lib/services/reports/access.ts` | Catalogue lists only permitted reports | Ungranted user → /auth/unauthorized; a granted user without Inwarding sees no INV cards |
| T4a | PO-01 | T1, T3 | `lib/queries/reports.ts` (PO-01 section), `lib/services/reports/open-po.ts`, `app/reports/[reportId]/…` | Report live on dev | DB test + reconciliation R1 |
| T4b | PO-02 | T4a (shares `reports.ts`) | same files, PO-02 section | | DB test + R2 |
| T4c | INV-01 + INV-02 | T4a | `lib/services/reports/invoice-checks.ts`, `reports.ts` INV section | | DB test + R3, R4 |
| T4d | DQ-01 | T4a | `lib/services/reports/data-quality.ts` | | DB test per check |
| T5 | Export route | T4a–d | `app/api/v1/reports/[reportId]/export/route.ts` | XLSX/CSV per report | E1–E3 |
| T6 | Grant `/reports` on dev, click-through, commit | T5 | — | Ready to deploy | Ajay's sign-off. Deploy and any prod DDL on separate go-aheads |

T4b–d all edit `lib/queries/reports.ts`, so they run **after** T4a, one at a time, not in parallel.

## Tests

**Unit (`node:test`, pure):**
- price class for each `po_type` and NULL/0 price
- IST today at 23:30 IST and 00:30 IST
- open predicate over every status

**DB (`withRollback`, fixtures via `tests/helpers/db.ts`):**
- **R1:** a master 1000 with two splits of 300/200, receipts 100 on the master and 250 on a child, plus one invoice receipt that also creates an inward PO. PO-01 open qty = 1000 − 350 − invoice qty, counted **once**. The inward PO doesn't appear.
- **R2:** fill % for that fixture equals hand math. A cancelled PO is excluded. Short-close shows in its own column.
- **R3:** a reverted invoice is absent from INV-01. An invoice with `invoice_total` ≠ sum of lines appears once with the right gap.
- **R4:** INV-02 diff % for a line at 105 vs PO 100 = 5%. A special-type PO line is excluded and counted.
- **S1 scope:** a user scoped to brand A sees no brand-B rows or lines in any report **or** its export, including an invoice with mixed-brand lines.
- **S2 access:** the export returns 403 without the source slug, even with `/reports`.

**Export:**
- E1: export rows = page rows for the same filter
- E2: 413 above 50k (fixture with the cap lowered)
- E3: XLSX opens with the expected columns

**Reconciliation on dev data (manual, recorded in the PR):**
- PO-01 open qty for a mfg = the "Open qty" card on FG PO Tracking for the same mfg.
- INV-01 count of variance invoices = the invoices summary strip.

## Acceptance criteria
- **PO-01:** totals match FG PO Tracking's Open card for the same filter. No inward or split-child rows. Unpriced/special rows show "—" plus a badge, never ₹0. Overdue uses the IST date.
- **PO-02:** fill % ≤ 100 except true over-receipt, which is flagged. The lead-time column states its start date.
- **INV-01/02:** reverted invoices excluded. Per-line brand scope proven by S1. Freshness line shows the oldest GRN sync.
- **DQ-01:** each check's count equals its list length (to the 200 cap) and links to the screen that fixes it.
- **All:** the page and export share one service. 403 without the source slug. Lint and `tsc` clean. Every Phase 1 query uses an index per dev `EXPLAIN`, or the full scan is accepted in writing for small tables.

## Risks and rollback
- **Risk: wrong numbers erode trust.** Mitigations: the R1–R4 tests, reconciliation against existing screens, and a Definitions panel on every report.
- **Risk: slow queries on prod.** Mitigations: no `SELECT_COLS`, indexes, the 50k export cap, and `timedQuery` warnings. If a report is slow, gate it off in the catalogue registry with no deploy rollback needed beyond a commit.
- **Risk: a scope leak.** Mitigations: S1/S2 tests, and one shared service for the page and its export.
- **Rollback:** the whole feature is additive (new pages, routes and services; `nav: true` flag; index DDL). Revert the commit and drop the indexes with `DROP INDEX`. No data is written by any report.

## Open questions (not blocking T1–T3)
- Thresholds: "missing leg older than N days" (default 7) and the INV-02 diff % flag (default 2%, matching `MATCH_TOLERANCE`).
- Whether Phase 3 inventory (a Uniware stock snapshot ingest) should be planned next.
- The read-only prod checks listed in `independent-review.md` (flip count, `history_pos` time offset, prod `idx_po_reference_po`), each run only on Ajay's go-ahead.

## Outside this scope (reported, not fixed)
- The six export scope mismatches
- The `approvals/entity-history` scope gap
- The invoice-line export brand leak (C4)
- `route-scope.test.ts` not catching query-string ids
- The hard-coded Uniware credentials
