# Review: `docs/invoice-revert-plan.md` (soft revert through approval)

**Reviewer:** independent plan review, 2026-10-14. Read-only: no code, schema, plan or DB was touched.
**Verdict:** the design holds up. The generated-column key swap, "stale = `cancelled` + `stale_at`", the PO_EDIT-style approval and the reader inventory are mostly right and well evidenced. **One Critical and seven Major findings** need resolving before G0 sign-off. Most of them are missing guards or gates, not design flaws.

Line references are to the working tree as of today, which includes uncommitted changes (see M7).

---

## Critical

### C1. The GRN guard trusts a cached count that can be NULL or a day stale
**Evidence.** §7: "A GRN exists: any `grn_uniware.invoice_id = I` **or** `uniware_grn_count > 0`". `uniware_grn_count` is only a cache of the last status pass. `schema.prisma:164-168` says "NULL = never asked". `lib/queries/uniware-grn.ts:16-23` explains why the GRN sweep stopped trusting it. It is refreshed only by the status sweep (`app/api/v1/purchase-orders/uniware-status/route.ts:152`) or the GRN walk (`lib/uniware/grn-sync.ts:176`). The full sweep is admin-only and nightly (`uniware-status/route.ts:107-111`). `NULL > 0` is false in SQL, so a never-synced invoice passes the guard.

**Why it matters.** A wrong invoice is most likely found when the warehouse tries to GRN it. If the GRN landed after the last sweep, the revert takes `received_qty` off the procurement PO while Uniware holds the stock. Re-inwarding the same number then mints a second Uniware PO, and stock is booked twice. That is the double-count the feature exists to prevent, and the plan cannot see it.

**Correction.** At request and again at approve, call the existing read `fetchPurchaseOrderStatus(I.uniware_po_code, facility)` live. It is already used by the status route, so no new payload is involved and the TEST_FACILITY rule is not triggered. Refuse when `grnCount > 0` or the status is `COMPLETE`. Persist the answer with `setUniwareStatus` / `setGrnCount` so the stored values agree. If Uniware is unreachable, refuse with a clear "cannot confirm no GRN" message. Never fall back to the cached count. Inside the approval transaction this holds row locks for one HTTP call, which `invoice-inward.ts:26-28` already accepts as a cost. Add it to the §7 table and to the T5 DB test (stub the fetch).

---

## Major

### M1. Brand scope on a *write* is weaker than the inward path that created the rows
**Evidence.** The plan's only guard is `scope: { type: "invoice" }`, which resolves to `assertInvoiceInScope`. That function passes if **any** line is in the user's brand scope (`lib/invoice/invoice-guard.ts:40-51`). The inward POST it undoes uses `assertSkuCodesInBrandScope` (`app/api/v1/purchase-orders/invoice/route.ts:30`), so every SKU must be in scope.

**Why it matters.** A user scoped to brand A could revert a mixed A+B invoice. That decrements `received_qty` and reopens procurement POs of brand B, which they cannot even see.

**Correction.** In the request route, after the `scope:` check, run `assertSkuCodesInBrandScope` over all line SKUs and `assertPoInScope` over every distinct `received_against_po_id`. This mirrors the inward rule. Approver scope remains Open decision 2.

### M2. A Uniware cancel or human cancel that lands first would break the "stale" step
**Evidence.** §6 step 5 plus step 8 ("Assert row counts … POs staled"), and the guard "inward PO already `stale_at`" in §7. Inward POs can already be `cancelled` with `stale_at NULL` in three ways:
- the Uniware cancel sweep (`uniware-grn.ts:63-69`, `uniware-status/route.ts:158-160`);
- a bulk CSV, since `bulkUpdateBlock` allows `cancelled` on a non-draft PO (`lib/po/po-bulk-check.ts:10,27-46`);
- the cancel route, for legacy `raised` inward POs (`app/api/v1/purchase-orders/[id]/cancel/route.ts:19`).

Cancelling the Uniware PO by hand before reverting is the natural order for the desk, and it is exactly what happened on 2026-10-08.

**Why it matters.** If the stale UPDATE is written as `WHERE status <> 'cancelled'`, or the count is taken from status changes, the row-count assertion fails and the revert can never be approved in the most common flow. History would also gain a `cancelled → cancelled` row.

**Correction.** Spell out the step as:
- `UPDATE … SET status='cancelled', stale_at=NOW() WHERE id IN (…) AND stale_at IS NULL`;
- assert on rows stamped with `stale_at`, not on status changes;
- write the `status` history row only when the old status ≠ `cancelled`.

Add a DB test case: an inward PO already `cancelled` by the Uniware sweep, then reverted.

### M3. The gate between reader code and the prod migration is implicit
**Evidence.** §1 step 2 says the readers "ship first". Its gate is only tests and tsc. G1 (prod DDL) comes after step 8. Step 2 adds `si.reverted_at` / `po.stale_at` to the hottest queries (`INVOICE_LIST_BODY`, `SELECT_COLS`).

**Why it matters.** If step 2 is merged to `main` and any unrelated release is tagged before G1, every PO list and invoice list on prod returns `Unknown column`.

**Correction.** Add an explicit gate: **no commit that reads a new column reaches `main` until G1 has run on prod**. Either keep steps 2–7 on a branch, or move G1 directly after step 1's dev verification. §12 shows the DDL is backward compatible with the old code, so running prod DDL early is safe, but it still needs Ajay's separate go-ahead.

### M4. The "receipts are reversed" behaviour needs explicit sign-off
**Evidence.** Requirement (2) says "mark all its corresponding entries stale". §3 deliberately does **not** mark procurement POs or their `history_pos` receipt rows stale. It subtracts `received_qty` and may reopen the PO instead.

**Why it matters.** Reversing is correct: a stale marker on a receipt would leave `received_qty` and every open-qty figure wrong. But it is the one place the plan departs from the literal ask, and it is the part with real side effects (reopening, Draft display). It should not be approved by accident.

**Correction.** Add a G0 line: "Receipts on procurement POs are *reversed* (with history rows), not marked stale. Confirm." Also note the side effect from Minor m9: a reopened PO with no `email_sent_at` and zero receipts reads back as **Draft** and becomes editable and mailable.

### M5. Open decision 8 (mail "after approve") cannot be built within the stated scope
**Evidence.** The approval route has no per-module post-commit hook. After `conn.commit()` it only loops over `revalidateTag` (`app/api/v1/approvals/[id]/route.ts:115-128`). `applyAndArchive` runs *inside* the transaction (`:104`), and §4 puts changes to the shared route out of scope.

**Why it matters.** Sending mail from `applyAndArchive` sends before commit. A later guard failure or commit failure would then announce a revert that never happened. Importing the mailer into the handler also pulls `lib/mail/mailer` into the `MODULE_HANDLERS` graph, which `tests/unit/cache-invalidation.test.ts:76` imports in a credential-less unit run.

**Correction.** Either drop the mail from phase 1, or add an optional `afterCommit?(entityId, items)` to `ModuleHandler` (`lib/approvals/handlers/types.ts:13`) and call it after commit, non-fatally. That is a small change to the shared route and should be stated as such. Keep mailer imports lazy (`await import`) inside that hook.

### M6. A re-inward while the old Uniware PO is still live invites a GRN against the wrong PO
**Evidence.** Phase 1 leaves the Uniware PO to a hand cancel (§3 last row, Risk 4). Re-inward mints a new Uniware PO carrying the same `ReferenceNo` (`invoice-inward.ts:449`). Note also that `invoice-inward.ts:16` says "Uniware exposes no cancel/delete for a PO", which undercuts phase 2.

**Why it matters.** For a while the warehouse sees two live Uniware POs for one physical invoice. A GRN on the old one is mirrored onto the reverted invoice and its stale POs, and the alarm fires after the stock is already booked.

**Correction (pick one at G0).**
- (a) *Simplest:* make "Uniware PO is `CANCELLED`" an **approve-time guard**, using the live status from C1. The hand cancel then happens before approval, "Uniware cancel pending" disappears, and the status sweep no longer needs to keep reverted rows for this. M2's fix makes the earlier Uniware-sweep cancel harmless.
- (b) Keep the plan, but have the inward POST warn or refuse when a reverted predecessor `(mfg_id, invoice_no)` has `COALESCE(uniware_status,'') <> 'CANCELLED'`.

Option (a) also deletes Risk 4 and most of phase 2's urgency.

### M7. The plan builds on PO_EDIT, which is uncommitted
**Evidence.** `git status`: `lib/po/po-edit.ts` is untracked. `lib/approvals/handlers/purchase-orders.ts`, `lib/approvals/module-handlers.ts`, `app/approvals/approvals-types.ts`, `lib/queries/purchase-orders.ts` and `tests/unit/cache-invalidation.test.ts` are modified and unstaged. Every "pattern copied from PO_EDIT" reference, and the line numbers for `edit_pending` (`purchase-orders.ts:259`) and `selectPoHistoryByPoId`, point into that dirty tree.

**Why it matters.** If PO_EDIT is reshaped or dropped before this lands, the template and the history-source trick (§5, `edit_reason` within 2 s) change under the plan.

**Correction.** Add a gate before step 1: "PO_EDIT (`docs/po-draft-edit-plan.md`) committed and on dev". Re-check the line refs at that point.

---

## Minor

| # | Finding | Evidence | Correction |
|---|---|---|---|
| m1 | Two concurrent requests could both pass `hasPending` and leave two pending approvals. The second is then un-approvable (it 500s on "already reverted") until someone rejects it. | `approvalsSql.hasPending` is a plain SELECT (`lib/queries/approvals.ts:216-220`). PO_EDIT avoids this by locking the PO **before** `hasPending` (`app/api/v1/purchase-orders/[id]/route.ts:182-186`). | State the order in §6/§7: `SELECT … FROM invoice_mfg WHERE id=? FOR UPDATE` first, then `hasPending`, inside the request transaction. The `hasPending` lookup for `revert_approval_id` at approve is then unambiguous. |
| m2 | The derived "Uniware cancel pending" is wrong when the status was never synced. | `uniware_status <> 'CANCELLED'` is NULL when `uniware_status` is NULL. | Use `COALESCE(si.uniware_status,'') <> 'CANCELLED'`. This is moot if M6(a) is taken. |
| m3 | Verify and payment check-then-write is not atomic, so a write can land on a just-reverted invoice. | Both routes write with bare `execute` and no transaction (`verify/route.ts:58-60`, `payment/route.ts:33,50`). The FK insert waits on the approve's X-lock and then succeeds. | Do the 409 check and the write in one statement or transaction (`… WHERE EXISTS (SELECT 1 FROM invoice_mfg WHERE id=? AND reverted_at IS NULL)`, or `FOR SHARE` on the header). Consider still allowing *withdraw* (`verified:false`, `status:null`) while pending; it only removes blockers. |
| m4 | The approvals page groups by `isNewRecord(items)`, not by `approval_type`. | `app/approvals/ApprovalsClient.tsx:46-49`. The plan says `approval_type='edit'` puts the request in Edits (§4). | Make sure at least one `approval_items` row has a non-empty `old_value` (the `receipt:`/`inward_po:` rows do). Put `invoice_no` in `old_value` as well, so an invoice with no receipts doesn't land in "New". |
| m5 | The summary strip excludes reverted invoices but the list and pager show them, so the counts disagree with no explanation. | `selectMatchFields` vs `countInvoices` (§5). | Have the strip say "N reverted not counted", or count them separately. |
| m6 | Reader inventory: minor omissions, none harmful. | `selectInvoiceForMatch` (`supplier-invoices.ts:646`, covered by the verify 409). `SELECT_COLS` `uniware_status` subquery (`purchase-orders.ts:254`, safe because codes are per invoice). `setUniwareLineQty` / `selectInwardPosByUniwareCode` write and read stale POs (`uniware-grn.ts:86-90,154-158`, desirable). The status sweep still calls `syncGrnsForInvoice` for reverted invoices with `grnCount>0` (`uniware-status/route.ts:185-189`), so excluding them from `selectForGrnSync` only covers one of the two GRN paths. That is fine as the alarm, but say so. `scripts/_check-invoice-reconciliation.ts:31-43` (run by `npm run test:checks`) will flag reverted invoices. | Add these to §5 as "checked, no change" (or "label" for the reconciliation script). |
| m7 | Excluding reverted rows from `invoicesInwarded` (daily digest) changes what a past day's count meant. | `lib/queries/daily-digest.ts:42-49` counts "inwarded in the window" by `created_at`. | Keep counting them, since the inward did happen that day, and let `approvalsDecided` show the revert. Or add a `reverted` bucket. Your call; just decide deliberately. |
| m8 | The T5 fixture plan exports `writeInvoiceAndPos`, whose module imports S3, Uniware, the mailer and the pool at load time. | `lib/invoice/invoice-inward.ts:35-48`. No existing DB test imports it. | Add a `makeInvoice(conn, …)` fixture builder to `tests/helpers/db.ts` that uses `supplierInvoicesSql.insertHeader/insertItem` + `receivePo` + `insertInwardReceived`, matching the pattern of `makePo`. Leave `invoice-inward.ts` unexported. |
| m9 | A reopened procurement PO with `email_sent_at IS NULL` and `received_total = 0` displays as **Draft**. PO_EDIT can then edit it, and the mail flow can "newly raise" it. The 123 directly imported POs have no send stamp. | `DISPLAY_STATUS_EXPR` (`purchase-orders.ts:125-132`), `canDirectEditPo` (`lib/po/po-rules.ts:32-36`). | Accept and document it under M4, or reopen to `raised` only when `email_sent_at` is set and leave the rest to a human. |
| m10 | The four-eyes refusal surfaces as `500 "Database error: …"`, and the UI still offers Approve on your own request. | `approvals/[id]/route.ts:135-145`. `ApprovalsClient` has only `isApprover`. | Hide or disable Approve when `raised_by` = viewer for `INVOICE_REVERT` (frontend is Claude's). Keep the handler check as the real guard. |
| m11 | `schema.prisma` sync is under-specified. Adding two more `users` relations to `supplier_invoices` makes the existing unnamed `users` relation (`:173`) ambiguous, and the `approvals` FK needs a back-relation. | `schema.prisma:170-174`, `:21-38`, `:340`. | Name all three user relations (including `created_by`), add the back-relation fields on `users` and `approvals`, and run `npx prisma validate` (not `generate`). |
| m12 | Lock ordering is unspecified. Revert locks several procurement POs, while a concurrent inward locks them in invoice-line order, so a deadlock is possible. | `receivePo` FOR UPDATE per line (`invoice-inward.ts:185`, `po-receive.ts:57`). | Lock procurement and inward POs in ascending `id`. A deadlock rolls back one side cleanly (the inward fails before its Uniware call). Map `ER_LOCK_DEADLOCK` to "try again". |
| m13 | Denormalised audit columns. `reverted_by` / `revert_approved_by` duplicate `approvals.raised_by/approved_by`. Since Reverted is terminal, at most one approved `INVOICE_REVERT` exists per invoice. | §3, §8. | Optional simplification: keep `reverted_at` + `revert_approval_id` (FK), join for names, drop two FKs and two columns. Keep `revert_reason` only if the list needs it without a join. Keep as planned if Ajay wants the columns. |
| m14 | Legacy invoice lines with `po_id IS NULL` exist by design. | `prisma/add_invoice_item_reference_po.sql:25-32`. | Add a pre-flight count on both schemas (`SELECT link_type, COUNT(*) FROM invoice_items_mfg WHERE po_id IS NULL GROUP BY link_type`) and a T4/T5 case showing that such a line reverses its receipt and stales nothing. |
| m15 | "Assumption: the approvals card renders unknown `field_name`s" was not verified here. | Only BOM, bulk and recipe have special renderers (`ApprovalCard.tsx:39-40`). | Confirm in step 7 on dev. `field_name` is `VARCHAR(100)` (`schema.prisma:13`), so `receipt:<po_no>` fits. |
| m16 | The approval history and `listPending` are unscoped for `/approvals` viewers, so invoice numbers, manufacturers and PO numbers in `approval_items` are visible to everyone with that page. | `app/api/v1/approvals/route.ts:23`. | This is the existing posture for every module. Note it under Open decision 2. |
| m17 | Small line drift. | `observability-business.ts`: the query is at `:34`, `FROM` at `:39` (fine). The `lowOpenByMfg` fix compares as DECIMAL, which is correct. | None. |

---

## Verified correct

- **Generated column + key swap.** MySQL 8 InnoDB allows a UNIQUE index on a generated column (STORED or VIRTUAL). Multiple NULLs are allowed in a UNIQUE index, so reverted rows step aside. `IF(reverted_at IS NULL, invoice_no, NULL)` is deterministic and allowed. `invoice_no` is `VARCHAR(100) NOT NULL` (`prisma/add_supplier_invoices.sql:21`), matching the generated `VARCHAR(100)`. The table default is `utf8mb4` (`:45`), and the collation pre-flight is the right check, since the generated column takes the table default. `DROP INDEX x, ADD UNIQUE KEY x (...)` in one ALTER is a valid redefinition. `idx_supplier_invoices_mfg (mfg_id)` exists (`:40`), so the mfg FK keeps an index. STORED means ALGORITHM=COPY with a write block, which is fine at about 55 rows. VIRTUAL would avoid the copy but is not necessary. No base column (`invoice_no`, `reverted_at`) is in an FK, so the "no CASCADE on a generated column's base column" restriction does not apply. Statement order is correct (§2 adds `reverted_at` before §3 references it). The rollback drops `live_invoice_no` before `reverted_at`.
- **Duplicate-key path.** `describeDbError` matches `message.includes("uq_supplier_invoice")` (`invoice-inward.ts:571-573`). MySQL 8.0.19+ prints `for key 'invoice_mfg.uq_supplier_invoice'`, which still matches because the name is kept. Every insert into `invoice_mfg` names its columns (`supplier-invoices.ts:242`, `tests/db/uniware-po-serial.test.ts:16`), so the generated column is never written.
- **Stale = `cancelled`.** `EFFECTIVE_STATUS_EXPR` lets `cancelled` win (`purchase-orders.ts:74`). It is excluded by `summaryStats` (`:383-386`), `CHILD_AGG_JOIN` (`:41`, which excludes inward anyway), `selectMonthlyPoSummaryByMfg/AllMfgs` (`manufacturing.ts:200,214`), `overviewByMfg` (`:246`), `ongoingByMfg` (`:1001`), `openForReceiveByMfg` (`:972`), `RECEIVABLE` (`po-receive.ts:14`) and `CLOSEABLE` (`close/route.ts:16`). A new ENUM value would read back as `received`, because inward POs carry `received_qty = qty` (`:481-485`). `cancelInwardPosByUniwareCode` is idempotent on already-cancelled rows (`uniware-grn.ts:68`). The 8-value status ENUM is confirmed (`schema.prisma:1165-1174`).
- **Invoice lines stale by parent.** Every runtime reader of `invoice_items_mfg` either joins `invoice_mfg` or is keyed by `invoice_id`. `findByMfgAndNo` / `poNosForInvoice` have no callers.
- **Approval mechanics.** `applyAndArchive(conn, entity_id, items, approverId, raised_by, raised_on)` runs inside the route's transaction (`approvals/[id]/route.ts:100-115`). Reject calls `setStatus` and requires remarks (`:59-62,108`). `markApproved` runs after the handler, so `hasPending` still finds the row. A double approve is serialised by the handler's `FOR UPDATE` on the invoice: the second sees `reverted_at`, throws and rolls back. The PO_EDIT shape is as described (`po-edit.ts:56,116`; `handlers/purchase-orders.ts:35-40`; `module-handlers.ts:46`). `entityLabelSql` (`approvals.ts:17`), `MODULE_LABEL`/`MODULE_COLOR` (`approvals-types.ts:39,117`) and the `NO_CACHE` requirement (`cache-invalidation.test.ts:79-100`) are all real. Invoices are not cached anywhere (`lib/cached-reference-data.ts`). No self-approval check exists today.
- **Receipt reversal.** Inward credits through `receivePo` once per line, with that line's `qty` (`invoice-inward.ts:185`), so Σ line qty per PO is the exact inverse. Auto-close happens only when `allocated === 0` (`po-receive.ts:102`), so "never reopen a split parent" matches. `childSplitSummary` excludes inward children (`purchase-orders.ts:761-768`) and should be the reopen check. `RECEIVED_TOTAL_EXPR` and the parent roll-up recompute on their own when the receipt was on a split child.
- **Access and scope.** The editor pair `/po-tracking/invoices` + `/po-tracking/po-inwarding` matches the inward POST (`invoice/route.ts:84`). The new `…/invoice/[id]/revert/route.ts` with `scope: { type: "invoice" … }` satisfies `tests/unit/route-scope.test.ts:8-9,57-86`. The approval route is unscoped by declared exemption (`route-scope.test.ts:20-25`; `approvals/[id]/route.ts:36-46`).
- **Must-not-exclude pins.** `maxUniwarePoSerial` (`supplier-invoices.ts:426`), `lastSeqByPrefix` (`purchase-orders.ts:420`, MAX not COUNT), the S3 owner selects (`s3-files.ts:32,37`) and the scope selects (`:487,499`).
- **Small fixes are real.** `lowOpenByMfg` reads any `received_qty` row as a receipt (`:1145-1151`). `bulkUpdateBlock` would let a CSV short-close a cancelled inward PO (`po-bulk-check.ts:27-46`). `selectByPoNo` lacks `stale_at` (`:826-832`). `InvoiceGroupTable.tsx` has no `Menu`.
- **Tests.** Pure rules in `tests/unit` and the handler and helper tested under `withRollback` follow the house pattern (`tests/helpers/db.ts:71-83`, refuses prod). `DB_NAME_TEST` is the non-prod schema (`lib/env.ts:39`). The string-pin tests have precedent (`invoice-sync-candidates.test.ts`, `uniware-cancel-inward.test.ts`). New SQL with literal predicates keeps `invoice-filters.test.ts` param counts.
- **Migration gates.** Dev first, then stop, and prod on its own go-ahead. Not re-runnable (no `ADD COLUMN IF NOT EXISTS` on MySQL 8). The pre-flight covers the column, index, FK-index and collation failure modes.

---

## Round 2 consistency check

I checked revision 2 of the plan against D1–D16, the disposition table, and the code.

**Critical:** none. **Major:** none.

### 1. Decisions D1–D16 against the plan body
Every decision is reflected, and nothing in the body contradicts one. I found no leftover live Uniware check, warehouse mail, `afterCommit`, Phase 2 work or cancel tick. The only mentions of these are the decision rows that drop them (D2, D7). The remaining Uniware statements in §2 and Risk 2 say "not touched", which matches D2.

### 2. Dispositions of the C and M findings
- **C1:** Resolved by D2/D13. §6 now uses `COALESCE(uniware_grn_count,0) > 0`, which fixes the NULL hole. The staleness gap is accepted in Risk 2.
- **M1:** Implemented in §3. `assertSkuCodesInBrandScope` is at `invoice/route.ts:129-132` (verified), followed by `assertPoInScope` over every reference PO and inward PO.
- **M2:** Implemented in §5 step 5 (`WHERE stale_at IS NULL`, plus a status history row only when the PO was not already cancelled). The step 8 count is consistent with it, and T5 tests the case.
- **M3 / M7:** Both are in the sequencing table as G0 (PO_EDIT on `main`) and G1 (prod DDL after the dev verify, before any reader code reaches `main`).
- **M4 / M5 / M6:** Resolved by D1, D7 and D2.

### 3. The "Not reconciled" item: plain-words errors at approve
The proposed change is small and safe. In `app/api/v1/approvals/[id]/route.ts:135-145`, after `conn.rollback()` and `recordFailedEvent`, add `if (err instanceof ApiError) throw err`. `finally` still releases the connection. `withGateway` already turns an `ApiError` into `{ error, code, requestId }` with the right status (`lib/gateway/with-gateway.ts:172-174`). `ApprovalsClient.tsx:116-118` shows `data.error` on any non-ok response, so the UI needs no change. The bulk-approve loop (`:183`) only checks `res.ok`.

The change does reach beyond INVOICE_REVERT. An `ApiError` from PO_EDIT's re-plan (`lib/po/po-edit.ts`) or `receivePo` would now return 409/400 instead of 500. That is an improvement, but say so in T6.

The three Assumptions (D8 "PO matching" = `skuHistoryByMfg` + the summary strip; `invoicesByWeek` keeps counting; the card renders custom fields) are reasonable readings and need no change.

### 4. Spot-check of new references and DDL
The DDL is unchanged from round 1 apart from the new informational pre-flight count, which is valid. These references are all correct: `invoice/route.ts:129-132`, `po-receive.ts:102`, `ApprovalsClient.tsx:46-49`, `uniware-status/route.ts:185-189`, `purchase-orders.ts:125-132` and `lib/env.ts:39`. I found no new factual errors.

### Minor findings
- **r2-1:** `selectMatchFields` cannot return `reverted_count` once it adds `WHERE si.reverted_at IS NULL`, because the excluded rows are gone. Specify either a separate count with the same `INVOICE_WHERE` plus `si.reverted_at IS NOT NULL` (and the same params), or keep the rows and filter in TypeScript.
- **r2-2:** §4 "Checked, no change" calls the `uniware_status` subquery (`purchase-orders.ts:254`) "unreachable once the sweeps exclude reverted". It is a read, not a sweep. It stays safe because each invoice has its own Uniware code. Reword it.
- **r2-3:** `assertPoInScope` and `assertSkuCodesInBrandScope` read through the pool, not the request's connection. Run them before opening the request transaction, so they don't hold a connection while the invoice row is locked.
- **r2-4:** With D8 excluding reverted invoices from the status sweep as well, a GRN booked on the old Uniware PO after the revert is now invisible. Round 1 kept that sweep as the alarm. This is consistent with D2/D8 and Risk 2 states it, so it is noted only so the trade-off is visible at sign-off.
