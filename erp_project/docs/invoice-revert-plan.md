# Revert an inwarded invoice — soft revert through approval

**Status:** built on dev (2026-10-14): migration applied to `mcaff_prefg_dev`, backend + UI written, unit + DB tests green. **Not yet:** G0 (PO_EDIT committed), G1 (prod DDL), the §9 click-through on dev, commit.

## Context

On 2026-10-08 two Reve invoices (`RP/L/26-27/1378`, `RP/L/26-27/1391`) were inwarded
wrongly and undone by hand on prod. The receipts were reversed, and the inward POs,
their history, the lines and the invoice were deleted. The deletes cost us twice. The
PO-number generator counted rows and reissued a live number (`lastSeqByPrefix`,
`lib/queries/purchase-orders.ts:412-424`, fixed in 558f5dd), and the audit trail for
those POs is gone. This plan makes revert a UI action that **deletes nothing**: the
invoice is marked reverted, everything hanging off it is marked stale, and the
revert goes through approval so we know who asked and who approved.

## Decisions (Ajay, 2026-10-14)

| # | Decision |
|---|---|
| 1 | **Receipts are reversed, not marked stale.** On procurement POs, `received_qty` drops by the invoice's line qty; the original history stays and a reversal `history_pos` row is added. Inward POs go to `cancelled` + `stale_at`. Invoice lines count as stale through their reverted invoice and get no column of their own |
| 2 | **One live Uniware call only: the GRN search (D17).** No "Uniware PO must be CANCELLED" gate, no cancel API — Phase 2 is **dropped** |
| 3 | **Who may request:** whoever may inward an invoice, with the same scope rule as the inward POST (every line SKU and every touched PO in scope) |
| 4 | **Who may approve:** unchanged — any `/approvals` editor |
| 5 | **Four-eyes:** the requester can never approve their own revert. No admin exception |
| 6 | **Payment guard:** any `invoice_payment` row blocks the revert |
| 7 | **No warehouse mail and no `afterCommit` hook.** The desk re-inwards the corrected invoice and tells the warehouse by its own mail |
| 8 | **Visibility:** reverted invoices stay in the list and exports, greyed, with a Reverted badge and reverted-by / approved-by shown. They are left out of the summary strip, Dispatch History, the Uniware sweeps and PO matching. The daily digest keeps counting them on their original day |
| 9 | **Audit on the invoice row:** `reverted_by`, `revert_approved_by`, `reverted_at`, `revert_reason`, `revert_approval_id` |
| 10 | **No time limit** on reverts |
| 11 | **Rollout:** PO_EDIT is committed and on dev first. Prod DDL runs right after the dev verify, with its own go-ahead, before any reader code reaches `main` |
| 12 | **Reopen:** only a PO the reverted receipt had auto-closed (stored `received`, now outside tolerance) goes back to `raised`. A PO a person short-closed or cancelled keeps its status |
| 13 | **Local GRN guard stays as well:** block if the ERP's own copy already shows a GRN (`grn_uniware` rows or `COALESCE(uniware_grn_count,0) > 0`) |
| 17 | **Live GRN search (2026-10-14, later):** `fetchInflowReceiptCodes(invoice.uniware_po_code, await requireFacilityForInvoice(invoice))` (`lib/uniware/grn.ts:51`; facility resolved exactly as the GRN sync does, `lib/uniware/grn-sync.ts:195`, Uniware `getInflowReceipts` — already used by the GRN sync, so no new payload and no TEST_FACILITY proof needed). Any GRN code → **block**. Uniware unreachable / timeout / auth failure → **block** with "try again later". Invoice never mirrored (`uniware_po_code IS NULL`) → skipped |
| 18 | **When:** at request (dry run and submit) **and** again at approve (inside the approval; adds ~1–3 s while the invoice is locked — accepted) |
| 19 | **Long-lived popup:** a blocking dialog that stays until the user clicks OK (not a toast), naming the Uniware PO, every GRN code, and "reverse these GRNs in Uniware first, then request the revert again". Shown to the requester and to the approver |
| 14 | **Own request:** Approve is disabled on the requester's own revert card, and the server refuses it too. Reject stays available |
| 15 | **Re-inward is a normal inward:** no approval, no special path. The number frees up the moment the revert is approved, through the generated-column unique key. The summary strip shows "N reverted not counted" |
| 16 | **Acceptance = the 10 dev checks in §9** |
| 20 | **Inward POs are marked `reverted`, not `cancelled` + `stale_at` (Ajay, 2026-10-14, later).** `purchase_orders.status` gains `reverted`, appended to the ENUM; `stale_at` is dropped. It is terminal everywhere `cancelled` is: `EFFECTIVE_STATUS_EXPR`, `summaryStats`, `ongoingByMfg`, the three `manufacturing.ts` filters and the Uniware cancel sweep (`NOT IN ('cancelled', 'reverted')`). An inward PO the sweep had cancelled still becomes `reverted`, with a history row. Supersedes every `stale_at` mention below; `prisma/add_invoice_revert.sql` is authoritative |
| 21 | **Remarks are compulsory** to request a revert: the dialog marks them required, the route refuses a submit without them, and the handler refuses to apply without them. Only the dry-run preview needs none |

---

## 1. Sequencing, gates, owners

| # | Step | Owner | Gate before the next step |
|---|---|---|---|
| G0 | PO_EDIT (`docs/po-draft-edit-plan.md`) committed and running on dev; line refs in this plan re-checked against it (D11, review M7) | Ajay | PO_EDIT on `main` |
| 1 | Migration `prisma/add_invoice_revert.sql` (§7) + `schema.prisma` sync | Claude writes, Ajay runs on **dev** (`mcaff_prefg_dev`) | Verify block passes on dev. **Stop.** |
| G1 | **Prod DDL**, on its own go-ahead | Ajay | Verify block passes on prod. **No commit that reads a new column reaches `main` before this** (D11, review M3). The DDL is safe under today's code (§11) |
| 2 | Readers learn "reverted" / "stale" (§4) | Ajay (snippets) or Claude on "you write" | `npm test` (new SQL pins), `npx tsc --noEmit --incremental false`, `npm run lint:changed` |
| 3 | Pure rules `lib/invoice/invoice-revert-rules.ts` + unit tests | same | `npm test` |
| 4 | Connection helper `lib/invoice/invoice-revert.ts` + `makeInvoice` fixture + DB tests | same | `npm run test:db` green on dev |
| 5 | Approval module `INVOICE_REVERT`; plain-words error at approve (§3) | same | `npm test`; DB test calls the handler directly |
| 6 | Request route + the verify / payment / documents lock | same | `tests/unit/route-scope.test.ts`; dry run on dev writes nothing |
| 7 | UI: request dialog, Reverted badge, Stale label, history label, Approve disabled on own card | **Claude** (frontend) | Ajay clicks through on dev |
| 8 | **Acceptance: the 10 checks in §9** | Ajay + Claude | All 10 pass |
| 9 | Deploy | Ajay | Smoke on prod: lists render; no reverted rows yet |

Order: **PO_EDIT → DDL dev → DDL prod → readers → write path → UI.** The readers must
be live before the first revert exists, or reverted rows leak into totals.

---

## 2. Lifecycle and what "stale" means

| State | How it is known | What is allowed |
|---|---|---|
| **Live** | `reverted_at IS NULL`, no pending `INVOICE_REVERT` | Everything, as today |
| **Revert pending** | `EXISTS approvals(module='INVOICE_REVERT', entity_id=id, status='pending')`, derived the same way as PO_EDIT's `edit_pending` | Read only. Verify, payment and document sync refuse with 409. Withdrawing a verification or payment is still allowed, since that only removes blockers (review m3) |
| **Reverted** | `reverted_at IS NOT NULL` | Read only, forever. The same number can be inwarded again as a new row (D15) |

1. **Request** (Live → Pending): the guards run on locked rows. Nothing on the invoice or any PO changes. One `approvals` row and display-only `approval_items` are written.
2. **Reject** (Pending → Live): remarks are mandatory (`app/api/v1/approvals/[id]/route.ts:59-62`). `setStatus` is a no-op, as for PO_EDIT, because the request wrote nothing.
3. **Approve** (Pending → Reverted): the approver must not be the requester. The guards run again on freshly locked rows, then the revert happens inside the approval route's transaction. Any failure rolls everything back, and the request stays pending.
4. Nothing leaves Reverted. A wrong revert is fixed by inwarding again.

| Table / thing | On approve | Stale marker |
|---|---|---|
| `invoice_mfg` | stamp the 5 audit columns (D9); generated `live_invoice_no` goes NULL | `reverted_at` |
| `invoice_items_mfg` | untouched | through its invoice (D1) |
| Inward `purchase_orders` (via `invoice_items_mfg.po_id`) | `status='reverted'` (D20); own `received_qty` left alone | `status = 'reverted'` |
| Procurement `purchase_orders` (via `received_against_po_id`) | `received_qty` reversed; reopened under D12. **Not stale** (D1) | — |
| `history_pos` | existing rows untouched; new rows appended (§5) | through its PO |
| `invoice_payment`, `invoice_leg_verification`, `grn_uniware` | must be empty (guards) | — |
| `attachments_invoice`, S3 PDF | untouched, still openable | through its invoice |
| `approvals` / `approval_items` | approved by the route | the record of who asked and who approved |
| Uniware PO | **not touched** (D2); the desk handles it by hand | — |

**Why stale = `cancelled` + `stale_at`, and not a new `stale` status.** A new ENUM
value falls through `EFFECTIVE_STATUS_EXPR` (`purchase-orders.ts:72-79`) to the
quantity math. Inward POs carry `received_qty = qty` (`:481-485`), so a stale PO would
read back as `received`, and it would count as live in `manufacturing.ts:200,214,246`,
`summaryStats` (`:383-386`) and `ongoingByMfg`. Every one of those already excludes
`cancelled`, and the Uniware cancel sweep already sets inward POs to `cancelled`
(`uniware-grn.ts:63-69`).

---

## 3. The approval flow

Module **`INVOICE_REVERT`**: `entity_id = invoice_mfg.id`, `approval_type='edit'`. It
copies PO_EDIT's plan-at-submit / apply-at-approve shape (`lib/po/po-edit.ts`).

| Piece | Where | What |
|---|---|---|
| Handler | new `lib/approvals/handlers/invoice-revert.ts` | `setStatus` is a no-op. `applyAndArchive(conn, id, items, approverId, raisedBy)`: refuse if `raisedBy === approverId` (D5), else `applyInvoiceRevert(conn, id, { reason, requestedBy: raisedBy, approvedBy: approverId })` |
| Registry | `lib/approvals/module-handlers.ts` | `INVOICE_REVERT: invoiceRevertHandler` |
| Labels | `entityLabelSql` (`lib/queries/approvals.ts:17`); `MODULE_LABEL` / `MODULE_COLOR` (`app/approvals/approvals-types.ts`) | `invoice_no` + manufacturer; label "Invoice Revert" |
| Cache test | `tests/unit/cache-invalidation.test.ts` `NO_CACHE` | `INVOICE_REVERT: "invoices are read live"` |
| `approval_items` (display only) | request route | `invoice_no` (old **and** new = the number, so the card groups under Edits and not New — `ApprovalsClient.tsx:46-49`, review m4), `manufacturer`, `reason`, `receipt:<po_no>` (received old → new), `reopen:<po_no>`, `inward_po:<po_no>` (status → cancelled) |
| Approval id for the stamp | helper | `hasPending('INVOICE_REVERT', id)` inside the transaction. It is unambiguous because the request locks the invoice before `hasPending` (§6) |
| Own card | `ApprovalsClient` / `ApprovalCard` (Claude) | Approve disabled when `raised_by` is the viewer for `INVOICE_REVERT`; Reject enabled (D14). The handler check is the real guard |
| Plain-words refusals at approve | `app/api/v1/approvals/[id]/route.ts:135-145` | Today any handler throw comes back as `500 "Database error: <msg>"`. One generic change: if the error is an `ApiError`, return its status and message. Needed for acceptance check 10 (see "Not reconciled") |

**Who may request (D3).** Editor on `/po-tracking/invoices` or `/po-tracking/po-inwarding`,
the same as the inward POST (`app/api/v1/purchase-orders/invoice/route.ts:84`). Scope:
`scope: { type: "invoice" }`, then `assertSkuCodesInBrandScope` over every line SKU (as
the inward POST does, `:129-132`), then `assertPoInScope` over every distinct
`received_against_po_id` and inward `po_id` (review M1).
**Who may approve (D4).** Any `/approvals` editor. That is unscoped by a declared exemption
(`approvals/[id]/route.ts:36-46`). Approval items are visible to every `/approvals`
viewer, as for every module (review m16).

---

## 4. Readers

The biggest risk of a soft revert is a reader that keeps counting a reverted row.
The list below comes from a grep for `invoice_mfg`, `invoice_items_mfg`, `po_type` and
`'inward'` over `lib/` and `app/`. All new predicates are literal, so no parameter
counts change, and `tests/unit/invoice-filters.test.ts` keeps passing. **No `?` in SQL
comments** (`supplier-invoices.ts:177-179`).

**Exclude reverted (`si.reverted_at IS NULL`):**

| Query | File:line | Decision |
|---|---|---|
| `selectMatchFields` (summary strip); returns a separate `reverted_count` for "N reverted not counted" | `lib/queries/supplier-invoices.ts:613` | D8, D15 |
| `dispatchedBySkuMfg` (MFG Overview → Dispatch History) | `:731` | D8 |
| `skuHistoryByMfg` (invoice → SKU / PO matching tie-break) | `:220` | D8 "PO matching" |
| `selectAllForStatusSync`, `selectForStatusSyncByFilter` (status sweep; also its GRN walk at `uniware-status/route.ts:185-189`) | `:287`, `:306` | D8 sweeps |
| `selectForGrnSync` | `lib/queries/uniware-grn.ts:31` | D8 |
| `selectSyncCandidates` (documents sweep) | `lib/queries/uniware-documents.ts:61` | D8 |

**Keep and label:**

| Query | File:line | Change |
|---|---|---|
| `INVOICE_LIST_BODY` → `listInvoices`, `listInvoicesForExport` | `supplier-invoices.ts:103-215` | add `reverted_at`, reverter / approver names, `revert_reason`, `revert_pending` (EXISTS) |
| `countInvoices` | `:473` | unchanged; it must match the list |
| `listInvoiceItemsForExport` | `:438` | add `si.reverted_at` |
| `selectByPoId` (FG PO inwarding panel) | `:356` | add `si.reverted_at`; the invoice is shown struck through |
| `selectInvoiceById` / `selectItemsByInvoiceId` / `selectGrnsByInvoiceId` | `:507`, `:519`, `:580` | `si.*` already carries the columns; the detail view shows a banner |
| `SELECT_COLS` (PO lists) | `purchase-orders.ts:228-261` | add `po.stale_at`; the badge reads **Stale**. `DISPLAY_STATUS_EXPR` is untouched, so tabs keep treating the PO as cancelled |
| `selectPoHistoryByPoId` | `purchase-orders.ts:860-910` | new source `'invoice_revert'` when a `revert_reason` row is within 2 s (the `edit_reason` trick), placed before the `received_qty` arms |
| `scripts/_check-invoice-reconciliation.ts:31-43` (`npm run test:checks`) | — | skip or label reverted invoices (review m6) |

**Keep, no change (must not exclude reverted):** `maxUniwarePoSerial` (`supplier-invoices.ts:426`)
and `lastSeqByPrefix` (`purchase-orders.ts:420`), because a used number must never be
reissued. Also the S3 owner selects (`s3-files.ts:32,37`), the scope selects
(`supplier-invoices.ts:487,499`), `invoicesInwarded` (daily digest, `daily-digest.ts:42`,
D8: original day) and `invoicesByWeek` (`observability-business.ts:34`, same reasoning).

**Checked, no change:**
- Already correct because stale = `cancelled`: `EFFECTIVE_STATUS_EXPR` (`purchase-orders.ts:74`), `CHILD_AGG_JOIN` (`:32-44`), `summaryStats` (`:378`), `openForReceiveByMfg` (`:950`), `ongoingByMfg` (`:992`), `manufacturing.ts:192,207,227`, `RECEIVABLE` (`po-receive.ts:14`), `CLOSEABLE` (`close/route.ts:16`).
- Behind the verify 409: `selectInvoiceForMatch` (`supplier-invoices.ts:646`).
- Unreachable once the sweeps exclude reverted invoices: the `uniware_status` subquery (`purchase-orders.ts:254`, codes are per invoice), `setUniwareLineQty` and `selectInwardPosByUniwareCode` (`uniware-grn.ts:86-90,154-158`).

**Small fixes the revert exposes:**

| Where | Problem | Fix |
|---|---|---|
| `lowOpenByMfg` (`purchase-orders.ts:1145-1151`) | a reversal row reads as "last receipt" | count only rows where `CAST(new_value AS DECIMAL(12,3)) > CAST(old_value AS DECIMAL(12,3))` |
| `bulkUpdateBlock` (`lib/po/po-bulk-check.ts:27`) | a CSV can short-close a stale inward PO | refuse when `stale_at` is set; add `stale_at` to `selectByPoNo` (`:826`) |
| verify / payment / documents routes | can write to a pending or reverted invoice; today's check-then-write is not atomic (review m3) | check and write in one transaction with `SELECT … FOR SHARE` on the header; 409 `revert_pending` / `invoice_reverted` |

**Dead queries (report only, do not delete):** `findByMfgAndNo` (`supplier-invoices.ts:329`)
and `poNosForInvoice` (`:339`) have no callers.

---

## 5. What the revert does (`lib/invoice/invoice-revert.ts`)

`planInvoiceRevert(conn, invoiceId)` reads, locks and checks, and writes nothing.
`applyInvoiceRevert` calls it again and then writes. Both take the caller's connection
and open no transaction.

1. **Lock** the `invoice_mfg` row first, then the lines, then every procurement PO
   (`received_against_po_id`) and inward PO (`po_id`) **in ascending `id`**. A concurrent
   inward then cannot deadlock against us in a way that leaves work half-done (review m12).
   `ER_LOCK_DEADLOCK` is mapped to "Another inward touched these POs — try again".
   Inward POs are found by the `po_id` link only, never by `invoice_no`, which a
   re-inward of the same number would share.
2. **Guards** (§6).
3. **Reverse receipts**, grouped per procurement PO: `received_qty -= Σ this invoice's line qty`,
   then `history_pos` `update / received_qty / old / new`. Legacy lines with `po_id IS NULL`
   reverse their receipt and stale nothing (review m14).
4. **Reopen (D12):** only when the stored status is `received`, the remaining qty is now outside
   `poTolerance(qty)` (`lib/po/po-rules.ts`), and `childSplitSummary` shows no live split
   children. `receivePo` never auto-closes a split parent (`po-receive.ts:102`). The status
   becomes `raised`, with a `history_pos` `status received → raised` row.
5. **Mark the inward POs reverted (D20, review M2):** `UPDATE … SET status='reverted' WHERE id IN (…) AND status <> 'reverted'`, plus a `status <old> → reverted` history row each.
   Add a `status` history row **only when the old status was not already `cancelled`**. That covers
   a PO the Uniware sweep or a person had already cancelled; it then just gets its `stale_at`.
6. **Every touched PO** gets `history_pos` `update / revert_reason / NULL / "Invoice <no> reverted (approval #<id>): <reason>"`,
   truncated to 255 characters. All history rows are credited to the requester, as PO_EDIT does.
7. **Stamp the invoice:** `reverted_at=NOW()`, `reverted_by`, `revert_approved_by`, `revert_approval_id`, `revert_reason`.
8. **Assert counts** before returning: POs reversed = distinct `received_against_po_id`;
   rows newly stamped `stale_at` = inward POs (all of them had `stale_at IS NULL`, which the guard
   checks); invoice stamped = 1. A mismatch throws and rolls back.

**Request transaction order (review m1):** `SELECT … FROM invoice_mfg WHERE id=? FOR UPDATE`,
then `hasPending`, then `planInvoiceRevert`, then insert the approval. Two concurrent requests
then serialise, and the second sees the first one's pending row.

---

## 6. Guards — checked at request and again at approve

| Guard | Plain-words refusal |
|---|---|
| Already reverted | "Invoice X was already reverted on <date>." |
| A revert is already pending (request only) | "A revert of X is already waiting for approval." |
| Typed number ≠ `invoice_no` (request only) | "Type the invoice number exactly to confirm." |
| Requester = approver (approve only, D5) | "You raised this revert, so someone else has to approve it." |
| GRN on the ERP's own record: any `grn_uniware.invoice_id = I` or `COALESCE(uniware_grn_count,0) > 0` (D13) | "Uniware already shows a GRN for X — reverse it there first." |
| **Live GRN search** on `uniware_po_code` returns any code (D17). Runs *before* the request transaction opens; at approve, inside the handler after the lock | Long-lived popup (D19): "This invoice can't be reverted — goods are already received in Uniware. Uniware PO `<po>` has GRN `<codes>`. Reverse these GRNs in Uniware first, then request the revert again." |
| Live GRN search **fails** (Uniware down, timeout, token) (D17) | Popup: "Couldn't reach Uniware to check for GRNs — please try again later." Nothing is written |
| Any `invoice_payment` row (D6) | "A payment state is recorded on X — clear it first." |
| Any `invoice_leg_verification` row | "X has verified legs — withdraw them first." |
| A procurement PO would go below 0 | "PO P would go below zero received — needs a manual fix." |
| An inward PO is referenced by another invoice's line or by `grn_items_uniware.po_id` | "Inward PO P is shared with another record." |
| An inward PO is already `reverted` (D20) | "Inward PO P is already reverted — data needs a manual check." |
| Out of scope (request only, D3) | the standard scope 403 |

The check runs at both points because the request is a preview that someone approves
later. The pending lock (§2) blocks the in-app writes in between; the re-check covers the rest.

---

## 7. Migration — `prisma/add_invoice_revert.sql`

> **Superseded in part by D20:** the file now appends `reverted` to `purchase_orders.status` instead of adding `stale_at`. The file is authoritative; the SQL below is the original draft.

Dev first (`mcaff_prefg_dev`), then stop. Prod runs at G1 on its own go-ahead. **Not
re-runnable**, because MySQL 8 has no `ADD COLUMN IF NOT EXISTS`; the pre-flight shows
whether it already ran. The `STORED` generated column means a table copy, which takes
seconds at about 55 rows.

```sql
-- ── 1. Pre-flight ──────────────────────────────────────────────────────────
-- Expect zero rows. Any row means this file already ran: stop.
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'invoice_mfg' AND COLUMN_NAME IN
          ('reverted_at','reverted_by','revert_approved_by','revert_approval_id',
           'revert_reason','live_invoice_no'))
     OR (TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'stale_at'));

-- Expect exactly (mfg_id, invoice_no). invoice-inward.ts matches the ER_DUP_ENTRY
-- message on this name, so the replacement keeps it.
SELECT SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND INDEX_NAME = 'uq_supplier_invoice' ORDER BY SEQ_IN_INDEX;

-- Expect another index leading with mfg_id, so the mfg FK survives the drop.
SELECT INDEX_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND COLUMN_NAME = 'mfg_id' AND SEQ_IN_INDEX = 1;

-- invoice_no's collation must equal the table default (the generated column takes
-- the default). If they differ, add COLLATE <that> to live_invoice_no below.
SELECT c.COLLATION_NAME AS column_collation, t.TABLE_COLLATION
  FROM information_schema.COLUMNS c
  JOIN information_schema.TABLES t
    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
 WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = 'invoice_mfg'
   AND c.COLUMN_NAME = 'invoice_no';

-- Informational: legacy lines with no inward PO (they reverse but stale nothing).
SELECT link_type, COUNT(*) FROM invoice_items_mfg WHERE po_id IS NULL GROUP BY link_type;

-- ── 2. Audit columns (D9) ──────────────────────────────────────────────────
ALTER TABLE invoice_mfg
  ADD COLUMN reverted_at DATETIME NULL
    COMMENT 'Set when an INVOICE_REVERT approval is approved. NULL = live' AFTER created_at,
  ADD COLUMN reverted_by INT NULL COMMENT 'Requester (approvals.raised_by)' AFTER reverted_at,
  ADD COLUMN revert_approved_by INT NULL COMMENT 'Approver (approvals.approved_by)' AFTER reverted_by,
  ADD COLUMN revert_approval_id INT NULL AFTER revert_approved_by,
  ADD COLUMN revert_reason VARCHAR(500) NULL AFTER revert_approval_id,
  ADD CONSTRAINT fk_invoice_mfg_reverted_by   FOREIGN KEY (reverted_by)        REFERENCES users (id),
  ADD CONSTRAINT fk_invoice_mfg_revert_appr   FOREIGN KEY (revert_approved_by) REFERENCES users (id),
  ADD CONSTRAINT fk_invoice_mfg_revert_apprvl FOREIGN KEY (revert_approval_id) REFERENCES approvals (id);

-- ── 3. One LIVE invoice per (mfg, number); reverted ones step aside (D15) ──
-- A UNIQUE index allows any number of NULLs. Same key name on purpose.
ALTER TABLE invoice_mfg
  ADD COLUMN live_invoice_no VARCHAR(100)
    GENERATED ALWAYS AS (IF(reverted_at IS NULL, invoice_no, NULL)) STORED
    COMMENT 'invoice_no while live, NULL once reverted. Never written' AFTER invoice_no,
  DROP INDEX uq_supplier_invoice,
  ADD UNIQUE KEY uq_supplier_invoice (mfg_id, live_invoice_no);

-- ── 4. Stale inward POs ─────────────────────────────────────────────────────
ALTER TABLE purchase_orders
  ADD COLUMN stale_at DATETIME NULL
    COMMENT 'Its invoice was reverted. status is cancelled alongside' AFTER email_sent_at;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 7 rows: six invoice_mfg columns + stale_at.
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'invoice_mfg' AND COLUMN_NAME IN
          ('reverted_at','reverted_by','revert_approved_by','revert_approval_id',
           'revert_reason','live_invoice_no'))
     OR (TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'stale_at'));

-- uq_supplier_invoice is now (mfg_id, live_invoice_no).
SELECT SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_mfg'
   AND INDEX_NAME = 'uq_supplier_invoice' ORDER BY SEQ_IN_INDEX;

-- Zero rows: every existing invoice is live and its generated value matches.
SELECT id FROM invoice_mfg
 WHERE reverted_at IS NOT NULL OR NOT (live_invoice_no <=> invoice_no);
```

**Rollback DDL.** This only works while no invoice has been reverted. After that, the old
key can collide with a re-inwarded number.

```sql
ALTER TABLE invoice_mfg
  DROP INDEX uq_supplier_invoice,
  ADD UNIQUE KEY uq_supplier_invoice (mfg_id, invoice_no),
  DROP COLUMN live_invoice_no;
ALTER TABLE invoice_mfg
  DROP FOREIGN KEY fk_invoice_mfg_reverted_by,
  DROP FOREIGN KEY fk_invoice_mfg_revert_appr,
  DROP FOREIGN KEY fk_invoice_mfg_revert_apprvl,
  DROP COLUMN reverted_at, DROP COLUMN reverted_by, DROP COLUMN revert_approved_by,
  DROP COLUMN revert_approval_id, DROP COLUMN revert_reason;
ALTER TABLE purchase_orders DROP COLUMN stale_at;
```

**`prisma/schema.prisma` sync (review m11).** The model is still named `supplier_invoices`.
- Add `reverted_at DateTime? @db.DateTime(0)`, `reverted_by Int?`, `revert_approved_by Int?`, `revert_approval_id Int?`, `revert_reason String? @db.VarChar(500)` and `live_invoice_no String? @db.VarChar(100)`. Prisma has no generated columns, so `live_invoice_no` gets a "generated, never write" doc comment.
- Replace `@@unique([mfg_id, invoice_no], map: "uq_supplier_invoice")` with `@@unique([mfg_id, live_invoice_no], map: "uq_supplier_invoice")`.
- **Name all three `users` relations**, including the existing `created_by`, and add the back-relation fields on `users` and `approvals`.
- `purchase_orders`: add `stale_at DateTime? @db.DateTime(0)`.
- Check with `npx prisma validate`. Never run `prisma generate`.

---

## 8. Tasks

| # | Task | Files | Verified by |
|---|---|---|---|
| T1 | Migration + schema | `prisma/add_invoice_revert.sql` (new), `prisma/schema.prisma` | verify block on dev, then prod; `npx prisma validate` |
| T2 | Readers (§4) | `lib/queries/supplier-invoices.ts`, `uniware-grn.ts`, `uniware-documents.ts`, `purchase-orders.ts`; `scripts/_check-invoice-reconciliation.ts` | new `tests/unit/invoice-revert-readers.test.ts`: string pins that each excluding query has `reverted_at IS NULL` and that `maxUniwarePoSerial` / `lastSeqByPrefix` / `invoicesInwarded` do **not** (pattern of `invoice-sync-candidates.test.ts`) |
| T3 | Small fixes (§4) | `lib/po/po-bulk-check.ts`, `purchase-orders.ts`, verify / payment / documents routes | unit test on `bulkUpdateBlock` with `stale_at` set |
| T4 | Pure rules | new `lib/invoice/invoice-revert-rules.ts` | `tests/unit/invoice-revert-rules.test.ts`: grouping per PO, below-zero refusal, reopen inside / outside tolerance, split parent never reopened, short_closed / cancelled kept, already-cancelled inward PO gets no status row, reason truncation, legacy `po_id NULL` line |
| T5 | Helper + fixture | new `lib/invoice/invoice-revert.ts`; `makeInvoice(conn, …)` in `tests/helpers/db.ts`, built from `insertHeader` / `insertItem` + `receivePo` + `insertInwardReceived`. `invoice-inward.ts` stays unexported (review m8) | `tests/db/invoice-revert.test.ts` under `withRollback`: full revert; re-insert of the same `(mfg_id, invoice_no)` succeeds; each guard refuses with nothing written; an inward PO already cancelled by the Uniware sweep then reverted (review M2); legacy line |
| T6 | Approval module | new `lib/approvals/handlers/invoice-revert.ts`; `module-handlers.ts`; `lib/queries/approvals.ts`; `app/approvals/approvals-types.ts`; `tests/unit/cache-invalidation.test.ts`; `app/api/v1/approvals/[id]/route.ts` (ApiError passthrough) | DB test: `applyAndArchive` with requester = approver refuses; with someone else it applies |
| T7 | Request route | new `app/api/v1/purchase-orders/invoice/[id]/revert/route.ts` (`dry_run` returns the plan); Zod `{ reason: min(1), confirm_invoice_no, dry_run? }`; live GRN search (D17) before the transaction, returning `409 { code: "uniware_grn_exists", grn_codes }` or `503 { code: "uniware_unreachable" }` | `route-scope.test.ts`; dry run on dev writes nothing |
| T8 | UI (Claude) | `app/po-tracking/invoices/InvoiceGroupTable.tsx` (expanded row: **Request revert**, since there is no row menu; Reverted badge; pending marker; strip note); `app/po-tracking/po-inwarding/InvoiceHistoryDialog.tsx`; PO badge (Stale); `PoHistoryDialog.tsx` (`invoice_revert`); approvals card (Approve disabled on own revert); long-lived blocking dialog for `uniware_grn_exists` / `uniware_unreachable` at request and approve (D19) | §9 |
| T9 | Docs | `docs/po-inwarding.md`; CLAUDE.md module table (`INVOICE_REVERT`) | review |

---

## 8a. API contract (backend ↔ UI)

Both halves build to these shapes. Field names are final; change them here first.

| Where | Shape |
|---|---|
| Invoice list rows (`listInvoices`, export, `selectByPoId`) | `+ reverted_at: string\|null, reverted_by_name: string\|null, revert_approved_by_name: string\|null, revert_reason: string\|null, revert_pending: 0\|1` |
| Invoice detail (`GET …/invoice/[id]`) | header `si.*` already carries `reverted_at`, `reverted_by`, `revert_approved_by`, `revert_reason`; route adds `reverted_by_name`, `revert_approved_by_name`, `revert_pending` |
| Summary (`GET …/invoice/summary`) | `+ reverted_count: number` |
| PO list rows (`SELECT_COLS`) | `status` may be `"reverted"` (D20); no `stale_at` |
| PO history rows | `source` gains `"invoice_revert"` |
| `POST /api/v1/purchase-orders/invoice/[id]/revert` body | `{ reason, confirm_invoice_no, dry_run?: boolean }` — reason required unless `dry_run`; the typed number is checked only on submit |
| dry run → 200 | `{ ok: true, plan: { invoice_no, mfg_name, uniware_po_code: string\|null, receipts: [{ po_id, po_no, before, after, reopen: boolean }], inward_pos: [{ po_id, po_no, status_before }] } }` |
| submit → 200 | `{ ok: true, approval_id }` |
| live GRN found → 409 | `{ code: "uniware_grn_exists", error, details: { uniware_po_code, grn_codes: string[] } }` — withGateway nests extras under `details`; the UI merges them (`toRefusal`) |
| Uniware unreachable → 503 | `{ code: "uniware_unreachable", error }` |
| any other guard → 409 / 400 / 403 | `{ code, error }` (codes: `invoice_reverted`, `revert_pending`, `confirm_mismatch`, `grn_recorded`, `payment_recorded`, `legs_verified`, `po_below_zero`, `inward_po_shared`, `inward_po_stale`, `out_of_scope`) |
| `POST /api/v1/approvals/[id]` approve refusal (ApiError passthrough) | same `{ code, error, … }` as above, incl. `self_approval`, `uniware_grn_exists`, `uniware_unreachable` |
| verify / payment / documents writes while pending or reverted → 409 | `{ code: "revert_pending" \| "invoice_reverted", error }` |

## 9. Acceptance — the 10 dev checks (D16)

1. **Inward** a test invoice on dev against a procurement PO that it fully receives, so the PO auto-closes.
2. **Request** a revert as user A: the dry run shows the receipts before → after; the invoice shows "Revert pending"; nothing on the invoice or its POs has changed.
3. **Self-approve is refused:** A sees Approve disabled on their own card, and a forced call is refused in plain words.
4. **Approve** as user B.
5. **PO reversed / reopened:** the procurement PO's `received_qty` is back, it is `raised` again, and its history shows the reversal and reason rows credited to A.
6. **Inward PO reverted, nothing deleted:** the inward POs read Reverted (D20), and every invoice, line, PO and history row still exists.
7. **List greyed, excluded from totals:** the invoice shows Reverted with A and B; the summary strip says "1 reverted not counted"; Dispatch History and the SKU/PO matching no longer count it.
8. **Re-inward the same number:** it succeeds with new inward PO numbers, and no total counts the goods twice.
9. **Reject leaves the invoice untouched:** request a revert on another invoice, reject it as B with remarks, and nothing has changed.
10. **Every guard refuses in plain words:** each §6 guard triggered on dev returns its message, at request, and at approve where it applies — including the **live GRN search** (a test invoice whose Uniware PO has a GRN on `TEST_FACILITY` shows the long-lived popup with its GRN codes) and **Uniware unreachable** (simulated by a bad token / timeout: "try again later", nothing written).

---

## 10. Risks

1. **A reader that still counts reverted rows.** Mitigated by §4 and the T2 string pins. A query written later is not covered.
2. **The Uniware PO stays live after the revert (D2).** The desk cancels it by hand. A GRN *before* approval is now caught live (D17/D18). A GRN booked on the old Uniware PO *after* approval is not seen, because the sweeps skip reverted invoices; accepted — the desk's own mail tells the warehouse to ignore the old one (D7).
3. **The live GRN search runs inside the approval transaction (D18)**, holding the invoice and PO locks for one Uniware round trip (`TIMEOUT_MS`). Accepted at this volume; a timeout blocks the approval rather than letting it through.
4. **The approver sees request-time numbers.** Apply recomputes from live data, and the reversal uses this invoice's own line qty, so other invoices' receipts are untouched. `history_pos` records what actually happened.
5. **A reopened PO can read as Draft** (review m9). A PO with no `email_sent_at` and zero receipts shows as Draft (`DISPLAY_STATUS_EXPR`, `purchase-orders.ts:125-132`), and becomes editable and mailable. The 123 directly imported POs have no send stamp. D12 reopens to `raised` regardless, and this is a documented side effect.
6. **Reopen turns a `punched` PO into `raised`.** The status before auto-close is not recorded (`po-receive.ts:101-105`).
7. **The generated column and key swap** is the one DDL with real failure modes. The pre-flight covers collation and the FK index, and it runs on dev first.

## 11. Rollback and backward compatibility

- **Existing invoices:** `live_invoice_no = invoice_no`, so the unique rule is unchanged. The verify block's last query proves it.
- **Today's code on the new schema** works. That is what makes G1 before the readers safe. `si.*` gains columns, the duplicate message still matches `uq_supplier_invoice` (`invoice-inward.ts:572`), and nothing old writes the new columns.
- **Rolling code back after the first revert:** old readers would count the reverted invoice and its re-inward twice. Roll forward instead.
- **DDL rollback:** only before the first revert.
- **The Reve invoices of 2026-10-08** were hand-deleted. Nothing remains to backfill, and their deleted history cannot be recovered.

---

## Review findings — disposition

| Finding | Disposition |
|---|---|
| C1 live GRN check | Resolved by D17/D18: live `getInflowReceipts` at request and approve, blocks when unreachable; local guard (D13) kept; post-approval gap accepted in Risk 2 |
| M1 write scope | Taken (D3, §3) |
| M2 already-cancelled inward PO | Taken (§5 step 5, T5 case) |
| M3 reader / DDL gate | Taken (G1 before step 2, D11) |
| M4 reversal sign-off | Resolved by D1; m9 side effect in Risk 4 |
| M5 mail after approve | Resolved by D7: no mail, no hook |
| M6 two live Uniware POs | Resolved by D2; noted in Risk 2 |
| M7 PO_EDIT uncommitted | Taken (G0, D11) |
| m1 concurrent requests | Taken (§5 request order) |
| m2 cancel-pending NULL | Moot: no "cancel pending" any more (D2) |
| m3 verify / payment atomicity | Taken (§4 small fixes, §2 withdraw allowed) |
| m4 Edits vs New grouping | Taken (`invoice_no` old = new, §3) |
| m5 strip vs list counts | Taken (D15, `reverted_count`) |
| m6 reader omissions | Taken ("Checked, no change" + reconciliation script) |
| m7 digest | Resolved by D8: keeps counting on the original day |
| m8 fixture | Taken (`makeInvoice`, T5) |
| m9 reopened PO reads Draft | Accepted, Risk 4 |
| m10 four-eyes UX | Taken (D14, §3) |
| m11 prisma relations | Taken (§7) |
| m12 lock order | Taken (§5 step 1) |
| m13 drop denormalised columns | Not taken: D9 keeps them |
| m14 legacy `po_id NULL` | Taken (pre-flight count, T4 / T5) |
| m15 card renders custom fields | Confirmed during step 7 on dev (Assumption) |
| m16 approvals visibility | Existing posture, unchanged by D4 |
| m17 line drift | No action |

---

## Verified facts vs Assumptions

**Verified (file:line)**
- `uq_supplier_invoice (mfg_id, invoice_no)`: `prisma/add_supplier_invoices.sql:39`, `schema.prisma:176`. The duplicate message keys on its name: `lib/invoice/invoice-inward.ts:571-573`.
- `purchase_orders.status` has no `stale`: `schema.prisma:1165-1174`. Inward POs are written with `received_qty = qty`: `purchase-orders.ts:481-485`. Legacy lines can have `po_id NULL`: `add_invoice_item_reference_po.sql:28-32`.
- `receivePo` credits `received_qty`, auto-closes only when there are no split children, and writes one history row: `po-receive.ts:49-119`.
- The Uniware sweep already sets inward POs to `cancelled`: `uniware-grn.ts:43-69`, `uniware-status/route.ts:158-167`.
- Approval route: remarks are mandatory on reject, `applyAndArchive` receives `raisedBy`, the route is unscoped, and errors come back as 500: `app/api/v1/approvals/[id]/route.ts:36-46,59-62,104,108,135-145`. No self-approval check exists today.
- Inward POST scope is `assertSkuCodesInBrandScope` over line SKUs: `app/api/v1/purchase-orders/invoice/route.ts:129-132`. It does **not** call `assertPoInScope` on reference POs, so D3's "every touched PO" is one step stricter than inward.
- `invoice_payment` and `invoice_leg_verification` cascade from the invoice (`add_invoice_payment.sql:42-43`, `add_invoice_leg_verification.sql:40-41`). `grn_uniware.invoice_id` has an FK (`add_uniware_grn.sql:88`). `attachments_invoice` has none (`add_uniware_documents.sql:61-83`).
- `history_pos.new_value` is `VARCHAR(255)`, and `action_type` is `create | update`: `schema.prisma:114-130,221-224`.
- `InvoiceGroupTable.tsx` has no row menu. `findByMfgAndNo` and `poNosForInvoice` have no callers.
- The review confirmed the generated column + key swap mechanics (review, "Verified correct").

**Assumptions**
- The key kept the name `uq_supplier_invoice` on both schemas through the rename. The pre-flight confirms it.
- `DB_NAME_TEST` is the dev schema (`lib/env.ts:39` per the review), so T5 needs the dev migration.
- The approvals card renders `receipt:<po_no>`-style rows as plain old → new (review m15). This gets confirmed on dev.
- "PO matching" in D8 means the invoice→SKU/PO matcher (`skuHistoryByMfg`) and the three-way summary. The Reference-PO picker (`openForReceiveByMfg`) lists procurement POs, not invoices, so it needs no change.
- `invoicesByWeek` (observability) keeps counting reverted invoices, by analogy with the digest. D8 is silent on it.

## Not reconciled

- **Check 10 at approve time** needs the approvals route to return a handler's `ApiError` as-is, instead of `500 "Database error: …"`. That is a small change to the shared route (T6), and none of the decisions covers it. Without it, refusals still read in words, but with a "Database error:" prefix. **Ajay to confirm.**
