# More ways to show the reporting data: plan

**Status (2026-10-27):** V1–V9 built on dev, uncommitted. V10 (the C items) waits for a go-ahead per item.
- **Reconciliation on dev:**
  - Group subtotals sum to totals on every dataset × grouping (0 mismatches); T1 grouped = live qty (8,400).
  - Inbox counts equal each source (0 mismatches).
  - Snapshot values equal live PO-01 / PO-02 (open 201,110; overdue 4; fill 1.174%).
  - Every scorecard figure equals its source report re-run per manufacturer (0 mismatches).
- **Tests:**
  - **Unit:** trace helpers (metrics, grouping), `exceptions-build` (every type), `snapshot-metrics`, `scorecard`.
  - **DB:** `trace-datasets` (11 tests, incl. row expand and the PO timeline).
- **D1:** `report_snapshots` is on dev only (`prisma/add_report_snapshots.sql`).
- **D2 (not given yet):** prod DDL, then `REPORT_SNAPSHOTS_ENABLED=1` (and `TRACE_EXTRACT_ENABLED=1` for the feed). Both jobs are registered and off by default.
- **Access on snapshot views:** unrestricted viewers see all series; manufacturer-limited viewers see only their manufacturers' series; brand- or warehouse-limited viewers see none, because the stored totals would leak data outside their scope.
- **Dev data is thin:** no GRNs and few problems, so most inbox types are zero there. Each type is proven by unit tests on the row builder.

**Scope (Ajay, 2026-10-27):** A (in-place table upgrades), B8 exception inbox, B9 trends, B6 manufacturer scorecard, B7 PO timeline, plus the further ideas in C.
B and C are new views, which Ajay asked for explicitly here; the standing "improve tables in place" rule still governs A.

## Principles
- **Every view reads the existing datasets or services.** No view gets its own arithmetic: a number on a scorecard is the same number its source report shows, so views can't drift apart.
- **Same access and scope** as the source dataset: `/reports` + source page + view scope, brand per line on invoice-derived rows.
- **No chart library.** Small charts are hand-written SVG, extending `components/observability/Sparkline.tsx`. Tables stay the primary surface.

## A. In-place table upgrades (Traceability datasets and Phase 1 reports)

| # | What | Where | Notes |
|---|---|---|---|
| A1 | **Expand a row to the next hop.** PO (T3) → its invoice lines (T1). Batch (T2) → its invoice lines + GRN lines (T5). Invoice line (T1) → GRN lines of the same batch key | T1/T2/T3 tables | Same expand pattern as split POs on FG PO Tracking. Rows are fetched on demand from a new read route, `GET /api/v1/reports/traceability/rows`, that calls the same services with a pinned filter |
| A2 | **Quantity bars in cells.** One segmented bar: ordered · via invoice · without invoice · open · short-closed (T3/T6, PO-01). Billed · arrived · rejected (T2) | in the qty column | Reuses PoTable's green/amber bar look; `title` gives exact numbers |
| A3 | **Group by with subtotals.** SKU / manufacturer / invoice / PO month, with a subtotal row per group and a grand total | every dataset tab | Grouped in TS over the filtered set (capped at 5,000 rows, with a warning), so subtotals are exact, not page-only |
| A4 | **Column chooser.** Pick which of a dataset's columns the screen shows | dataset toolbar | Remembered per tab in localStorage (try/catch); downloads always carry every column |
| A5 | **New computed columns** (appended to contract v1, which allows additions at the end) | T1, T2, T5, T6 | `shelf_life_months_at_receipt` = expiry month − inward month; flag `short_dated` when under the threshold (decision D4). `days_po_to_invoice`, `days_invoice_to_grn`. `rejection_pct` on T2/T6 |

## B. New views

**B8 Exception inbox** (`/reports/exceptions`): one queue of every open problem, newest-impact first.

| Exception | Source | Value used for sorting |
|---|---|---|
| Batch billed, not received / short received | T2 status | billed value of the gap |
| GRN batch not on any invoice | T2 `received_not_billed` | arrived qty × PO rate |
| GRN line not linked to an inward PO | T5 `linked = no` | arrived qty |
| Received without an invoice / data error | T3 provenance | qty × rate |
| Invoice rate above PO rate by more than 2% | INV-02 | value at stake |
| Invoice total ≠ lines, three-way variance | INV-01 | gap |
| Short-dated at receipt | A5 | billed value |
| Data-quality checks | DQ-01 | count |

Each row has: type, the record (linking to Trace), manufacturer, age in days, value, and a "why" line. Filters are type, manufacturer and age. Download works like the other reports.
**v1 is read-only.** Acknowledging or assigning items needs a table (D3).

**B9 Trends:** history the database doesn't keep, built from nightly snapshots.
- **Snapshot:** the existing 02:00 job also writes a few dozen **metric rows** per day into a new small table `report_snapshots(day, metric, mfg_code, value)`. This is decision D1; the alternative is reading the S3 CSVs back.
- **Metrics:** open qty and value (PO-01), overdue POs, fill % and lead median (PO-02), exception counts by type (B8), DQ counts, GRN sync age.
- **View:** a trend strip per metric (SVG sparkline + latest + change vs 7 and 30 days), per manufacturer or overall. It also feeds the scorecard.
- **History starts the day snapshots are switched on.** Nothing can be backfilled, because current-state tables can't tell us yesterday's open qty. **This is the one time-sensitive item.**

**B6 Manufacturer scorecard** (`/reports/scorecard?mfg=`): one page, one manufacturer, chosen period.
- **Figures:** fill %, lead median/p90, on-time % (PO-02); open qty, overdue POs and oldest open (PO-01); rejection % (GRN via T2); rate variance value and lines (INV-02); invoice exceptions (INV-01); receipts without invoice (T3); DQ counts for that manufacturer.
- **Each figure** links to the filtered source report, and carries a sparkline once B9 has history.
- **A league table** of all manufacturers, sortable, with the same columns, is the landing view.

**B7 PO timeline** (on Trace, when the key is a PO): one PO's life in date order. All events come from existing rows:
- **PO lifecycle:** raised (approval), approved, mailed (`email_sent_at`), edits and edit approvals, split (children).
- **Goods:** each invoice and its receipt (T4 match), each GRN (T5), revert, short-close / cancel / discard (`history_pos`).
- **Gaps:** days between steps are shown, e.g. "mailed 3d after approval; first invoice 41d later". Missing steps are shown as gaps, e.g. "no create history" on imported POs.

## C. Further ideas (proposed, lower priority)

| # | Idea | Why it earns a place |
|---|---|---|
| C1 | **SKU 360** on Trace when the key is a SKU. Open POs by manufacturer, recent invoices, batches with shelf life, rejection %, Supply Name, billed rate vs agreed final costing | Answers "what's going on with this SKU" in one place |
| C2 | **Inbound calendar.** Open qty due per destination warehouse per week, by expected dispatch, with overdue as its own column | Warehouse planning; data is PO-01 |
| C3 | **Invoice payment ageing.** Invoices by payment state (derived and manual) × age bucket, with value | Finance's view; data is `invoice_payment` + three-way |
| C4 | **"What changed since yesterday" mail.** From two snapshots: new POs, receipts, status flips, new and cleared exceptions. Sent 08:30 IST to `entity_emails` report recipients | Push instead of pull. Reuses mailer + cron, like the daily digest |
| C5 | **Billed rate vs agreed costing.** Invoice rate vs the agreed final costing for that SKU at that manufacturer, not just vs the PO | Catches POs raised at the wrong rate, which INV-02 can't see |
| C6 | **Freshness strip.** GRN sync age per facility on every GRN-based view, linking to the Sync button | Says when not to trust the GRN columns |
| C7 | **Shareable views.** A "copy link" button (filters already live in the URL). Named team presets would need a table | Zero-cost first step |

## Decisions (recommended defaults; the starred ones need Ajay)

| # | Decision | Recommended |
|---|---|---|
| D1 ★ | Where trend history lives | New `report_snapshots` table (DDL dev first, then prod on go-ahead), written by the 02:00 job. Not parsing S3 CSVs back |
| D2 ★ | Switch on the nightly job on prod (feed + snapshots) | **Yes, soon.** Every day it's off is a day of trend history lost |
| D3 | Exception inbox acknowledge/assign | v1 read-only; ack/assign later with its own table |
| D4 | Short-dated threshold | under 12 months of shelf life left at receipt, adjustable |
| D5 | Charts | hand-written SVG (sparkline + segmented bar), no library |

## Sequencing and gates

| Step | What | Depends on | Gate |
|---|---|---|---|
| V0 | This plan | — | Ajay's go-ahead + D1/D2 |
| V1 | A5 computed columns + unit tests (shelf life, lead days, rejection %) | V0 | `npm test`; contract doc updated (additions only) |
| V2 | A2 bars + A4 column chooser | V0 | visual check |
| V3 | A1 row expand + read route (route-scope exemption + docs/api entry, like the export route) | V1 | DB test: an expanded row = its dataset filtered to it |
| V4 | A3 group by + subtotals | V1 | Subtotals sum to the dataset total |
| V5 | B8 exception inbox | V1 | Each type's count equals its source report's count for the same filter |
| V6 | D1 table DDL (dev), snapshot writer in the 02:00 job, dev run | V5 (needs exception counts) | Dev rows written; prod DDL + enabling are separate go-aheads |
| V7 | B9 trends view + SVG sparkline | V6 | Renders from dev snapshots (seeded by running the job on several days) |
| V8 | B6 scorecard + league table | V5, V7 | Every figure equals its source report for the same manufacturer and period |
| V9 | B7 PO timeline | V3 | DB test fixture: events in order; imported PO shows its gaps |
| V10 | C items, one at a time, each on its own go-ahead | — | — |

Each step ends with tsc (`--incremental false`), `lint:changed`, `npm test`, `test:db`, and a dev reconciliation where numbers are involved.

## Risks
- **Two views disagreeing on a number:** prevented by reading the same services. Each view's gate checks equality with its source.
- **Trend history can't be backfilled:** stated on the trends view ("since <first snapshot day>"). Hence D2.
- **No GRN data on dev:** GRN-based figures (rejection %, the GRN parts of B8 and the scorecard) are proven by fixtures until prod has data.
- **Concurrent work:** the discard feature (new `discarded` status) is in the same files. Its status exclusions are already in `reports.ts` and `trace.ts`; new views reuse those expressions rather than listing statuses again.
