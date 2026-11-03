# Split PO fixes + serial table

## Context
A review of split POs (2026-10-29) found 9 bugs. Ajay's decisions on 2026-11-03:

| # | Ask | Decision |
|---|---|---|
| 1 | No auto-close | Applies to **every PO**. A short delivery stays Partially Received until someone short-closes it. A full receipt still reads Received, because that is derived. |
| 2 | Block short-close/cancel while a split is open | Yes |
| 3 | Server enforces it | Transaction + row locks, not UI-only |
| 4 | Invoice → split matching + destination | The receipt is **booked once, on the split**; the parent rolls it up (it already does, through `RECEIVED_TOTAL_EXPR`), so there is no double write. Destination match order: same destination (a PO with no destination counts as **Mumbai**), then POs with **no destination**, then other destinations **with a warning and a confirm-on-save dialog**. |
| 5 | No split without a destination | Yes |
| 6 | Explained in chat, not in scope | — |
| 7 | Overview double-count | Fix it, plus the tests listed below |
| 8 | Serial table | **All app-minted serials**: PO/IMP/bulk/inward/split, plus mfg/vendor/RM/PM codes |
| 9 | An unmailed split can be discarded | Yes |

Write this to `docs/split-po-fixes-plan.md` once approved.


> **Changed 2026-11-03 (Ajay):** FIFO never auto-picks another warehouse's PO — "that would never happen". Order is same warehouse, then no destination; anything left is a shortage. Another warehouse's PO can still be hand-picked in the Reference PO picker, which triggers the confirm-on-save dialog.
>
> **And:** Mumbai is every warehouse's fallback, since POs are raised against Mumbai first. Order: same warehouse → Mumbai (and POs with no destination) → shortage. A Mumbai fallback needs no confirmation; only a hand-picked PO for any other warehouse does.

## Sequencing and gates
Each phase ships on its own. The gate for every phase: `npm test` + `npm run test:db` + `npx tsc --noEmit --incremental false` + `npm run lint:changed` are green before the next phase starts.

| Phase | Items | DDL | Risk |
|---|---|---|---|
| A | 1, 2, 3, 9: receive, close, cancel and discard rules | none | Medium. It changes how every PO closes. |
| B | 5: split requires a destination | none | Low |
| C | 4: destination-aware FIFO + server checks on the reference PO | none | Medium. It can block invoices that go through today. |
| D | 7: overview and summary totals | none | Low. Read-only queries. |
| E | 8: serial table | **new table, dev only, then stop.** Prod needs a separate go-ahead, then a seed run. | High. Every number minted goes through it. |

Order A→B→C→D→E. E is last, so the rule fixes don't wait on DDL.

## Phase A: lifecycle rules (items 1, 2, 3, 9)

**New `lib/po/po-lifecycle.ts`.** It takes a `PoolConnection` and never begins or commits; the route owns the transaction.
- `lockPoFamily(conn, poId)`: lock the **parent first, then its children** (`SELECT … FOR UPDATE`, children ordered by id). This lock order is the deadlock rule, and every writer below follows it.
- `assertCanShortClose(family)`: the stored status is raised/punched, **and** the PO has no open split. A split counts as open when it isn't cancelled, discarded, short-closed or received in full.
- `assertCanCancel(family)`: the same status check, plus `received_qty = 0` on the PO **and** no live split (any that isn't cancelled or discarded). This re-checks on the server what `PoTable.tsx:148` checks in the UI today.
- Pure predicates (`openChildren`, `cancelBlock`, `closeBlock`) live in `lib/po/po-rules.ts`, so they can be unit-tested, and the UI imports the same ones.

**Routes:**
- **`[id]/close/route.ts` and `[id]/cancel/route.ts`:** wrap each in a transaction, call `lockPoFamily`, assert, then write the status and `history_pos` in that same transaction. A refusal returns 409 `open_splits` or `has_receipts`, naming the split numbers.
- **`PO_BULK` handler** (`lib/approvals/handlers/purchase-orders.ts:210`, `updatePoStatusFields`): runs the same asserts per row and skips a refused row with the reason, the same skip pattern the handler already uses.
- **`receivePo`** (`lib/po/po-receive.ts`): remove the auto-close (`:101-105`), so it never writes `'received'`. For a split, lock the parent row first, then the split, which follows the lock order. Keep the over-limit check.
- **Invoice revert:** `shouldReopen` keeps working for old rows that are stored `'received'`. New rows are never stored that way, so nothing changes there.

**UI** (`PoTable.tsx:135-160`): `canShortClose` uses the new open-split predicate. Its current tolerance gate is wrong for a split parent, because its own remainder is 0. `canDiscard` follows item 9.

**Item 9:** `discardBlock` (`po-rules.ts:39-53`) allows a split that is unmailed, stored `raised`, with no receipts and no invoice lines. Its qty goes back to the parent automatically, because `CHILD_AGG_JOIN` already skips discarded rows. `po-discard.ts` locks the parent then the split.

**Existing data:** POs already auto-closed to `'received'` are left alone.

## Phase B: destination on splits (item 5)
- `poSplitRowSchema.destination` becomes required, non-empty (`lib/validation/purchase-order-detail.ts`).
- The split route calls `assertDestinationActive` **and** `assertDestinationServesEntity` (`lib/po/po-guard.ts`), so the warehouse must exist and serve the brand's company.
- `SplitPODialog.tsx` pre-fills each row with the parent's destination and won't submit a blank one.
- Move `selectForSplit` and `childSplitSummary` inside the transaction, using `lockPoFamily`. That closes the race between a split and a receipt.

## Phase C: destination-aware FIFO (item 4)
- `openForReceiveByMfg` also returns `COALESCE(po.destination, 'Mumbai') AS match_destination`, plus `destination_missing` (whether the stored value is NULL).
- `OpenPoOption` (`types/invoice.ts`) gains those two fields.
- **`allocateFifo`** (`app/po-tracking/po-inwarding/invoice-form.ts:326`): its buckets are keyed by SKU today. Each SKU's POs get ranked in three passes:
  1. POs whose `match_destination` equals the invoice's destination;
  2. POs whose destination is missing;
  3. anything left is a shortage, the existing no-reference-PO row that `collectProblems` already blocks. Its message gains "at <destination>".

  Within a pass the order stays FIFO by date. A parent with splits contributes only its unallocated remainder (as today), and each split is its own candidate with its own destination. A split sharing the invoice's SKU, manufacturer and destination is picked before its parent's other-destination remainder. The receipt books on the split, and the parent rolls it up.
- **Server re-check** in `lib/invoice/invoice-inward.ts`, before `receivePo` (`:199-202`). Each reference PO must:
  - belong to the invoice's `mfg_id`;
  - have the line's SKU;
  - not be an inward PO;
  - have a destination that equals the invoice's, or none at all (treated as Mumbai: an exact match for a Mumbai invoice, the second pass for any other);
  - be in the user's scope (`assertPoInScope`).

  A failure returns 400 `reference_po_mismatch` naming the line. The same eligibility rule is pure and shared: `lib/invoice/po-eligibility.ts`, used by both the client and the server.
- **A mismatch is a warning, confirmed on save (Ajay, 2026-11-03).** It does not block.
  - **FIFO pass 3:** after same-destination and no-destination POs, FIFO falls back to **other-destination POs**, oldest first. Only when none at all is left does the line become a shortage, as today.
  - **On the line:** each line booked against another warehouse's PO shows an amber note, "PO is for Mumbai, invoice is for Gurgaon".
  - **On Save Invoice:** if any line mismatches, a confirmation dialog lists every mismatched line (SKU, qty, PO number, PO destination → invoice destination). Saving needs an explicit **"Yes, book against these POs"**. **Go back** returns to the form unchanged.
  - **Server:** the request carries `confirm_destination_mismatch: true`. If a line mismatches without it, the server answers 409 `destination_mismatch` with the lines, so an old client or a direct API call can't skip the confirmation.
  - **Record:** for each confirmed line, a `history_pos` row is written on that PO: "booked from Gurgaon invoice <no>, destination mismatch confirmed". That way it can be traced later.
- **The user picks the correct one.** Two controls already exist in Add Invoice:
  - **Destination field** (`InvoiceFields.tsx:172`): if the parser picked the wrong warehouse, the user corrects it. Changing it re-runs `allocateFifo`, so the lines re-match against that warehouse's POs.
  - **Reference PO picker** (`InvoiceLineItems.tsx:184`, `poOptionsFor`): lists the SKU's open POs in three labelled groups: same destination, no destination, other destination (each shown with its destination). The user can override FIFO's choice; picking an other-destination PO gives the same amber note and confirmation.
  - The other server checks (same manufacturer, same SKU, not an inward PO, in the user's scope) stay **hard refusals**. Only destination is a confirmable warning.
- **Parent history:** when a receipt lands on a split, also write one `history_pos` row on the parent ("received 500 via MPO-…-S002"). That marks it in the parent's history without touching its numbers.

## Phase D: overview totals (item 7)
The fix applies one pattern: `CHILD_AGG_JOIN` + `MASTERS_ONLY` + `COALESCE(po.po_type,'') <> 'inward'` + `RECEIVED_TOTAL_EXPR` + `DISPLAY_STATUS_EXPR` + `APPROVED_ONLY`.
- **`manufacturingSql.selectMonthlyPoSummaryByMfg`** (`lib/queries/manufacturing.ts:192`): counts each order once at its parent qty; received = its own receipts plus its splits'; pending = qty − received total.
- **`overviewByMfg`** (`:212`): `open_pos` counts logical parents only, using display status; `open_value` is the unreceived share.
- **Inward double-count on live cards:**
  - `lib/services/business.ts:66` passes `excludeInward=true` (Observability Business);
  - the daily digest's `statusCounts` (`lib/reports/daily-digest.ts:88`) does the same.
  - The PO Inwarding page's own cards stay as they are, since inward POs are its subject.
- PO records are not modified.

**Tests:** a new `tests/db/po-overview-split.test.ts`, built on `report-open-po.test.ts`, `makePo` and `insertSplit`. It covers:
- an unsplit PO;
- a split PO (1000 → 400 + 600);
- a split partly received;
- a split received in full.

Each case asserts parent qty is counted once, the open count is 1, pending equals the outstanding total across the splits, and received isn't double-counted (including the inward rows that `makeInvoice` creates).

## Phase E: serial table (item 8)

**DDL** `prisma/add_serial_counters.sql`, applied to dev only, then stop:
```sql
CREATE TABLE serial_counters (
  scope      VARCHAR(100) NOT NULL PRIMARY KEY,  -- e.g. 'PO:MCAFF-PO-202611', 'SPLIT:MPO-OO113600', 'MFG'
  last_no INT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**`lib/serials.ts` `nextSerial(conn, scope, seed)`:**
- It runs `INSERT … VALUES (?, LAST_INSERT_ID(?)) ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`, then `SELECT LAST_INSERT_ID()` on the same connection. That is atomic, and the row stays locked until the caller commits. A rolled-back transaction gives its number back, so no gap is left.
- `seed()` runs only the first time a scope is used. It returns the existing MAX from today's query, so the numbering carries on from where it is.

**Callers switched, with formats unchanged:**
- PO, impromptu and special: `app/api/v1/purchase-orders/route.ts:145`. Move the read **inside** the transaction.
- bulk: `handlers/purchase-orders.ts:120`;
- inward: `invoice-inward.ts:167`;
- split: `split/route.ts:136`, now max-based, which also fixes the case where a reused suffix could follow a deleted split;
- mfg, vendor, RM and PM codes: `lib/master-routes/material-utils.ts:57-130`.

Also:
- The PO month switches to **IST** everywhere. Today it is server-local time in #1 and #3 but IST for inward, and that disagrees at month boundaries.
- Recipe `bom_code`, gatepass numbers, `history_masters_edits.version_no` and the dead `lib/uniware/po-serial.ts` stay as they are.

**Before prod:**
1. Ajay's go-ahead for the DDL.
2. A read-only dry run listing each scope's seed value from prod.
3. The release.

## Verification
- **Unit tests:** `closeBlock`, `cancelBlock`, `openChildren`, the `discardBlock` split cases, `allocateFifo` destination passes (same → missing → shortage, a split picked before the parent's remainder), and the eligibility rule.
- **DB tests:**
  - `lockPoFamily` + close/cancel refusals;
  - `receivePo` no longer stores `'received'`;
  - discarding an unmailed split returns its qty to the parent;
  - the inward server rejects a mismatched reference PO;
  - `nextSerial`: sequential and seeds from MAX, a rolled-back transaction gives its number back, and a second connection blocks until the first commits;
  - the overview tests above.
- **Manual, on local dev:** split a PO, try to short-close and cancel the parent (refused), discard the unmailed split (qty returns), and inward a test invoice against a split at the matching destination.
- The existing `tests/db/report-open-po.test.ts`, `po-split-price.test.ts` and `uniware-po-serial.test.ts` still pass.

## Risks
1. **No auto-close** leaves more POs Partially Received: anything that arrived 1–10% short now needs a manual short-close. The 08:00 low-open report will list more of them at first.
2. **Confirmation fatigue.** On prod, 85 invoices in the 30 days to 2026-11-03 were booked against a PO for a different warehouse, mostly Mumbai POs delivered to Gurgaon. Expect the confirmation dialog on about that many saves a month, and a risk that people click through it without reading. Mitigations: the dialog lists exact lines rather than a generic "are you sure", and each confirmation leaves a `history_pos` row naming the invoice, so the mismatches can be reported on and the PO-raising habit fixed. **Tell ops before the release.**
3. **Serial table:** wrong seeds would reissue numbers that are already taken. Mitigation: seed-on-first-use from MAX, the `po_no` UNIQUE index stays as a backstop, and a dry run on prod first. RM and PM codes have no unique index, so the seed is their only guard.
4. **Release dependency:** prod runs v0.1.26. None of this reaches prod until a release carries it.
