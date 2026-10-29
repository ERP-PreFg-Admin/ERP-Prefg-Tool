# Traceability datasets: plan

**Status (2026-10-27):** U0–U7 built on dev; U8 (signed-in click-through, then commit) is with Ajay.
- **Dev reconciliation:**
  - T1 has 19 rows and 8,400 live qty, matching the raw lines.
  - T2 billed equals the raw live qty.
  - T3 has 37 POs with no unexplained opening balances.
  - T4: 10/10 events classified (8 exact invoice, 2 revert).
  - T6 equals PO-02 (204,510 ordered / 2,400 received).
- **Tests:**
  - **DB:** `tests/db/trace-datasets.test.ts` (9 tests) runs one fixture with every trap through all six datasets, checks the v1 contract keys, and proves the S3 read guard.
  - **Unit:** `tests/unit/trace-helpers.test.ts` covers the batch key, months, ledger statuses, receipt matching and provenance.
- **Nightly feed:** one test run wrote `reports/daily/test/2026-10-27/` (six CSVs + manifest). The cron job is registered but **only writes when `TRACE_EXTRACT_ENABLED=1`**; enabling it on any server is a separate go-ahead.
- **Dev has no GRN rows**, so T5 and the GRN half of T2 are proven by the fixture only.
- **One unexplained flake:** in one run T3's split child read `data_error`. It didn't reproduce in 10 further runs, and a debug print in the test now captures it if it recurs.

## Why
The Phase 1 reports summarise. The ask is a **data dump** at SKU and batch grain that maps procurement POs to invoices to inward POs to batches to Uniware GRNs. Users will pivot it in Excel, trace one SKU/batch/PO/invoice end to end, chase mismatches, and feed another tool nightly. So six canonical flat datasets carry everything. Screens, exception filters, downloads and the S3 feed are views over them, so they cannot disagree.

## Decisions (Ajay, 2026-10-27)
- **All four uses apply:** pivot, trace, reconcile, feed.
- **Batch match is loose:** `UPPER` and strip spaces, `-`, `/`, `.`, `_`. Raw spellings are always shown, with a `batch_match` flag.
- **Feed:** nightly CSVs to S3 via the existing cron. Unscoped; the S3 prefix is the access control.
- *Defaults:*
  - Reverted invoices appear flagged and never count in totals.
  - CSV uses snake_case keys; Excel uses labels plus a Read-me sheet.
  - 50k rows per sheet.

## How the data links (evidence: discovery, 2026-10-27)

```
procurement PO ──1:N── invoice line ──N:1── inward PO ──1:N── GRN line ──N:1── GRN
 (split child → master   (received_against_po_id)  (po_id; one per        (po_id, resolved   (grn_uniware.invoice_id
  via reference_po)                                 invoice × SKU)          by exact SKU)       → invoice)
```

- **Exact links:**
  - line → procurement PO (`received_against_po_id`)
  - line → inward PO (`po_id`)
  - GRN line → inward PO (`po_id`)
  - GRN → invoice (`invoice_id`)
  - child → master (`reference_po`)
- **Nothing below (invoice, SKU):**
  - Lines and GRN lines are many-to-many through the inward PO.
  - Batch pairing is a text match. No code does it today.
- **FIFO split:** one printed line becomes several `invoice_items_mfg` rows (one per PO settled), and `line_no` is the allocation index. Printed line ≈ (invoice, SKU, batch, expiry, rate).
- **Receipt provenance:**
  - Only invoice receipts are exact.
  - Manual receipts, the Sept backfill (`changed_by = 10`), the 2026-10-19 hand fix (`changed_by = 2`) and opening balances on the 123 `MPO-OO*` imports are inferred from `history_pos` deltas.
  - History coverage starts 2026-07-25.
- **GRN freshness:** manual Sync buttons only, with no cron and a 40-invoice cap per GRN sweep.
- **GRN `po_id` case sensitivity:** it is resolved case-sensitively in JS (`grn-sync.ts:165`). Datasets reach GRN lines via `grn_uniware.invoice_id`, so case-drifted lines are kept and flagged.
- **Date formats:**
  - Invoice expiry and mfg date are free text ("Jun-2026").
  - GRN dates are epoch ms or ISO.
  - Both are normalised to `YYYY-MM` in TS, else `unparseable`.
- **GRN quantity:** `quantity` is gross; accepted = `quantity − rejected_qty`.

## Datasets
Columns, sources and rules are in **`dataset-contracts.md`**.

| ID | Dataset | Grain |
|---|---|---|
| T1 | PO ↔ invoice line map | invoice line allocation |
| T2 | Batch ledger | invoice × SKU × batch key, outer-joined to GRN lines |
| T3 | PO receipt ledger | procurement PO (master and split child) |
| T4 | Receipt events | `history_pos` `received_qty` delta |
| T5 | GRN line dump | GRN line (`grn_code` + `line_no`) |
| T6 | SKU summary | SKU × manufacturer (× month) |

## Screens, downloads, feed
- **`/reports/traceability`:** a tab per dataset with filters (mfg, SKU, PO no, invoice no, batch, dates, status/flag) and server pagination.
- **`/reports/trace?q=`:** a PO no, invoice no, SKU or batch, shown as its whole chain on one page.
- **Downloads:**
  - Per tab, CSV or Excel.
  - **Workbook:** six sheets plus a Read-me for the same filter (`buildMultiSheetXlsx`).
- **Nightly feed:**
  - **Job:** cron `trace-extract` at 02:00 IST writes `reports/daily/YYYY-MM-DD/<dataset>.csv` plus `manifest.json` via `uploadFile`.
  - **Access gate:** the `reports/daily/` prefix must be unreadable through the app's file routes, proven by the `s3-key-owners` test.
- **Code layout:**
  - Pure logic: `lib/reports/trace/*.ts`.
  - SQL: `lib/queries/trace.ts`.
  - One service per dataset in `lib/services/reports/trace/*.ts`, shared by the page, the export and the cron.

## Scope
- **Access:** `/reports` + PO Inwarding (T1, T2, T5) or FG PO Tracking (T3, T4, T6).
- **Rows:** `getViewScope`. Brand is checked per line on invoice-derived rows. GRN lines are scoped through their invoice and SKU brand.
- **The feed is unscoped**, by decision.

## Sequencing

| Task | What | Gate |
|---|---|---|
| U0 | This doc + contracts | Ajay signs off the columns |
| U1 | Pure helpers + unit tests | `npm test` |
| U2 | T1, T5 | DB test: FIFO split, case-drift GRN, reverted |
| U3 | T2 | DB test: every status; dev Σ checks |
| U4 | T3, T4 | Dev: provenance parts sum to `received_qty` on every PO |
| U5 | T6 | Equals PO-02 for the same filter |
| U6 | Pages, exports, workbook | Export = page; scope tests |
| U7 | Nightly S3 feed + read guard | Dev prefix run; key-owners test; prod schedule on go-ahead |
| U8 | Click-through, commit | Ajay |

## Found during discovery: reported, not fixed
1. `grn-sync.ts:165` matches SKU case-sensitively, so GRN lines get `po_id = NULL`.
2. The `/purchase-orders/[id]/inwarding` "without invoice" figure counts reverted lines.
3. The invoice export omits the reverted flag, leaks other brands' lines, and has no row cap.
4. The PO export's Received Qty ignores split children.
5. Unfixed qty/rate swaps: MPO-INW-202610-166 and -167.
6. `docs/po-inwarding.md:235` says "one row per printed line", but FIFO splits them.
