# QA Audit — August 2026

> Scope of this pass: money and state-machine paths (PO receipt, PO split, approval apply, rate archiving), plus whatever surfaced while building the test harness. Branch: `feat/admin-panel-data-scoping`.
>
> Every "Confirmed" finding below has a test that fails if the behaviour changes. Reproduce all of them with `npm run test:db` / `npm test`.

## Baseline at the time of the audit

| Check | Result |
|-------|--------|
| `npm run build` | **Passes** with no DB and no secrets (every one of the 27 pages is server-rendered on demand, so nothing prerenders) |
| `npx eslint .` | **266 problems — 238 errors** at the start, ~all `@typescript-eslint/no-explicit-any`, across ~50 files. Now **235 errors**: extracting the split math removed three `as any` casts. Left otherwise untouched by decision. |
| `npm test` (new) | 57 pass |
| `npm run test:db` (new) | 36 pass |
| `npm run test:checks -- --db` | 10 pass (6 pure + 4 DB); 3 external ones not run |
| Automated tests before this pass | **None** |
| CI before this pass | **None** — no `.github/` directory existed |

---

## Confirmed defects

### 1. Splitting the same PO twice always fails — HIGH

**Where:** `lib/po-split.ts` `childPoNo()` (extracted verbatim from `app/api/v1/purchase-orders/[id]/split/route.ts`)

Child PO numbers are derived from the position within the **current request** (`-S001`, `-S002`, …), not from the children that already exist. `purchase_orders.po_no` is `UNIQUE`, so the second split of any PO regenerates `-S001` and dies on the unique index.

**Failure scenario:** raise `MCAFF-PO-001` for 1000 units → split off 100 to plant A (creates `MCAFF-PO-001-S001`) → later split off another 100 to plant B → `ER_DUP_ENTRY`. The user sees `500 Database error: Duplicate entry`. The parent's quantity is *not* reduced (the transaction rolls back), so no data is corrupted — but the operation is impossible and the error is unintelligible.

**Test:** `tests/db/po-split.test.ts` → *"CONFIRMED BUG: splitting the same parent twice collides on po_no"* — asserts `ER_DUP_ENTRY`, having first confirmed the split is legitimate on quantity (parent had 900 left).

**Fix:** derive the suffix from the existing child count, not the request index — `SELECT COUNT(*) FROM purchase_orders WHERE reference_po = ?` and offset by it. Note the race: two concurrent splits of the same parent would still collide, so keep the unique index as the backstop and surface `ER_DUP_ENTRY` as a retryable 409 rather than a 500.

### 2. A split zeroes `total_amount` when the PO has no unit price — MEDIUM

**Where:** `lib/po-split.ts` `parentAfterSplit()` — `newQty * Number(po.unit_price ?? 0)`

`unit_price` is nullable on `purchase_orders`. When it is `NULL`, the recomputed total is `newQty * 0 = 0`, so a PO that had a `total_amount` loses it silently on split. Nothing errors, and the PO list simply shows 0.

**Failure scenario:** a PO created by bulk CSV import without a unit price (`insertBulkPo` sets neither `unit_price` nor `total_amount`) but with a total entered later, or any PO whose price is recorded only at the line level. Split it → its value reads as 0 for the rest of its life.

**Test:** `tests/db/po-split.test.ts` → *"CONFIRMED BUG: parentAfterSplit zeroes total_amount when unit_price is NULL"*.

**Fix:** when `unit_price` is null, scale the existing total instead — `newTotal = oldTotal * (newQty / oldQty)` — or leave `total_amount` untouched. Either is a deliberate behaviour change, which is why the current behaviour is pinned by a test rather than quietly corrected.

### 3. A split can strand a fully-received PO as permanently open — MEDIUM

**Where:** `lib/po-split.ts` `splitPo()` + `EFFECTIVE_STATUS_EXPR` in `lib/queries/purchase-orders.ts`

A split reduces `qty` but deliberately leaves `status` and `received_qty` alone (correct: a split is not a receiving event) — **and never re-evaluates the tolerance rule.** Meanwhile the read-side status expression only derives `partially_received` while `received_qty < qty`:

```sql
WHEN po.received_qty > 0 AND po.received_qty < po.qty THEN 'partially_received'
ELSE po.status
```

So once `received_qty >= qty`, the effective status falls through to the stored `raised`.

**Failure scenario:** PO for 1000, 950 received (`partially_received`). The remaining 50 are cancelled by splitting them to another plant. Parent is now qty 950, received 950 — complete — but it reads as **`raised`** forever. It sits in the "open" tab of PO Inwarding, in the open-PO count, and in the Reference PO picker of the Add Invoice dialog. `receivePo` on it then computes `remaining = 0` and refuses any receipt with a confusing over-limit message.

**Test:** `tests/db/po-split.test.ts` → *"CONFIRMED BUG: a split can strand a fully-received PO as permanently open"*.

**Fix:** at the end of `splitPo`, re-apply the same rule `receivePo` uses — if `newQty - received_qty <= poTolerance(newQty)`, set status `received`. That reuses `lib/po-rules.ts` and keeps one tolerance policy.

### 4. `RM_RATE` approval loses the supersede date that `RM_VRM` keeps — LOW

**Where:** `lib/approvals/handlers/raw-materials.ts` — `rmRateHandler.applyAndArchive`

Archiving the outgoing manufacturer rate passes `effective_to = null`:

```ts
await conn.execute(rmSql.archiveToHistoryMrm, [
  cur.mfg_id, cur.rm_id, cur.approved_vendor_id ?? 0,
  cur.curr_rate, cur.effective_from, null,   // <- effective_to
  ...
])
```

`rmVrmHandler` in the same file passes `cur.effective_to`. So vendor rate history can say when a rate stopped applying and manufacturer rate history cannot — every `history_cost_mfg` row has an open-ended validity window.

**Failure scenario:** open the Rate History popup on RM Cost Master (Manufacturer view). Every superseded rate shows a start date and a blank end date, so two archived rates appear to have been in force simultaneously. Any costing back-calculation over a date range can't pick the right one.

**Test:** `tests/db/approval-apply.test.ts` → *"CONFIRMED BUG: RM_RATE archives effective_to as NULL, losing the supersede date"*.

**Fix:** pass the new rate's `effective_from` (or `CURDATE()`) as the archived row's `effective_to`, matching `rmVrmHandler`. Check `pmRateHandler` for the same asymmetry before fixing.

---

## Security findings

### 5. Any signed-in user can read or overwrite any S3 object — HIGH

**Where:** `app/api/v1/files/presign/route.ts`, `app/api/v1/files/preview/route.ts`, `app/api/v1/upload/route.ts`

All three are wrapped in `withGateway` (so a session is required) but declare **no `access` rule** and **no entity scope**, and they take the S3 key or folder straight from the caller:

| Route | Caller controls | Consequence |
|-------|-----------------|-------------|
| `GET /api/v1/files/presign?key=…` | the full object key | A presigned download/view URL for **any** object in the bucket — another manufacturer's documents, any supplier invoice PDF, any uploaded bulk CSV |
| `GET /api/v1/files/preview?key=…` | the full object key | The parsed contents of any CSV/XLSX in the bucket, returned as JSON |
| `POST /api/v1/upload` (`folder` + `field`) | the full key path | `uploadFile` is a plain `PutObject`, which **overwrites**. An existing invoice PDF or vendor document can be replaced. |

The only validation is a `key.includes("..")` check, which does nothing here — these are S3 keys, not filesystem paths, so no traversal is needed to reach a sibling object. Keys are also guessable/enumerable from the UI (`attachment_key` and `csv_source_key` are returned in ordinary list responses).

**Reproduce:** sign in as any active user, note an `attachment_key` from a PO belonging to a manufacturer outside your entity scope, then `GET /api/v1/files/presign?key=<that key>&view=1`.

**Fix:** two layers. (a) Add an `access` rule to each route. (b) Authorize the *object*, not just the session: resolve the key back to the row that owns it (`purchase_orders.attachment_key`, `invoice_mfg.attachment_key`, `approvals`' `s3_key` item) and run the existing `assertInScope` / `assertPoInScope` against it. For `upload`, derive the key server-side from the entity being uploaded against instead of accepting a caller-supplied path.

**Fixed for `presign` and `upload`.** New `lib/s3-guard.ts` (mirrors `lib/po-guard.ts`):

- `assertKeyReadable(userId, key)` resolves the key through `s3FilesSql.selectKeyOwners` — a UNION over every column that stores one (`purchase_orders.attachment_key`/`csv_source_key`, `invoice_mfg.attachment_key`, `history_pos.s3_key`, the four `*_key` columns on `details_vendor` and `details_mfg`, `artifacts_recipe.s3_key`, `approval_items.old_value`/`new_value`) — then applies `inScope` to the owner's `mfg_id` / `destination`. **A key owned by nothing is refused**, which is what closes enumeration. Master and approval-queue documents resolve unscoped, matching the list pages that show their rows (`lib/scope.ts`).
- `/api/v1/upload` now writes `${folder}/${field}-u<userId>-<12 hex>.${ext}`. The random token makes the `PutObject` overwrite impossible; the `-u<id>-` segment lets `presign` recognise a file the caller just uploaded but hasn't saved to any row yet — without it the document preview in the Add Vendor / Add Manufacturer dialogs (`components/ui/FileUpload.tsx` presigns straight after upload) would break.
- The `key.includes("..")` check is gone — it could never have caught anything.
- No `access` page rule was added: `presign` serves approvals, PO tracking, invoice history, BOM and the masters dialogs, so no single slug fits, and the per-object check is the stronger gate. A deliberate departure from (a), recorded here rather than done silently.

**Tests:** `tests/unit/s3-guard.test.ts` (the marker cannot be forged through the caller-supplied `field`; no two uploads share a key) and `tests/db/s3-key-owners.test.ts` (the UNION is valid against the real schema; an unowned key resolves to zero owners).

**Still open: `/api/v1/files/preview`** — same hole, and the fix is now two lines (`assertKeyReadable`, drop the `..` check). Left out only because this pass was scoped to presign.

### 6. Supplier invoices are readable by id regardless of scope — MEDIUM

**Where:** `app/api/v1/purchase-orders/invoice/[id]/route.ts`, `GET /api/v1/purchase-orders/invoice`

Both carry `access: { pageSlug: "/po-tracking", level: "viewer" }` but no scope assertion, while `invoice_mfg.mfg_id` makes every invoice manufacturer-owned. A user scoped to one manufacturer can read another's invoice header (both GSTINs, bill-to/ship-to, totals) and its line items by walking sequential ids.

`lib/scope.ts` already documents the supplier-invoice list as not-yet-scoped, so this is a known gap rather than a surprise — recorded here because the data is commercially sensitive and the fix is small: `assertInScope(scope, "mfg", invoice.mfg_id)` after loading the header, and `scopeClause("si.mfg_id")` on the list query.

> The other 16 routes that take an entity id without a scope assertion were reviewed and are **by design**: the masters (SKU, vendor, manufacturer, RM, PM, BOM, material master) are not manufacturer-scoped entities, and the approvals queue is explicitly documented as unscoped in `lib/scope.ts` (`approvals` stores only module + `entity_id`, and bulk modules store `entity_id = user_id`). `/api/health` needs no session by design.

---

## Correctness and hygiene findings

### 7. `withRetry` does not retry `ETIMEDOUT` — MEDIUM

**Where:** `lib/db.ts:36`

```ts
if (err.fatal || err.code === "ECONNRESET" || err.code === "PROTOCOL_CONNECTION_LOST") return fn()
```

A transient `connect ETIMEDOUT` **was actually observed during this audit** — the DB was reachable, then timed out for one call, then was reachable again. `ETIMEDOUT` on connect does not set `err.fatal` on the retry path reliably, so it surfaces to the user as a hard 500 on whatever page they were loading.

**Fix:** add `ETIMEDOUT` (and consider `EPIPE`, `ER_LOCK_WAIT_TIMEOUT`) to the retry list. Note the retry is a single immediate attempt with no backoff, which for a connect timeout is likely to fail the same way — a short delay before the retry would help.

### 8. `scripts/test-connection.js` is broken, and `npm run db:test` does not exist — LOW

The script imports `PrismaClient` from `app/generated/prisma/client.ts` and `@prisma/adapter-mariadb`, which is **not installed** — it fails immediately with `MODULE_NOT_FOUND`. It also contradicts the project's own rule that Prisma Client is never used at runtime.

**Fix:** rewrite it as three lines against `lib/db.ts` (`SELECT NOW()`), or delete it — `npm run test:checks -- --db` already proves connectivity.

### 9. Documented npm scripts do not exist — LOW

`CLAUDE.md` and `docs/environment-and-scripts.md` list `db:generate`, `db:migrate`, `db:push`, `db:studio`, `db:seed` and `db:test`. **None of them are in `package.json`** (before this pass the only scripts were `dev`, `build`, `start`, `lint`). Anyone following the docs — or an agent following `CLAUDE.md` — hits `npm ERR! Missing script`.

**Fix:** either add the scripts or correct the docs. `db:seed` is worth adding for real, since `scripts/seed-permissions.ts` is required on a fresh schema.

### 10. `rm_mrm` and `rm_vrm` do not exist — LOW (documentation)

`CLAUDE.md`'s registered-modules table said `RM_RATE` touches `rm_mrm` + `rm_mrm_history` and `RM_VRM` touches `rm_vrm`. The real tables are **`cost_master_rm_mfg`** and **`cost_master_rm_ven`**, archiving to **`history_cost_mfg`** / **`history_cost_ven`** — `SHOW COLUMNS FROM rm_mrm` errors outright. This cost time during this audit, and it is the exact class of error `CLAUDE.md` itself warns about ("always check `lib/queries/*.ts` for the real table names") while getting it wrong.

`docs/database-schema.md` has it **right** — it maps each Prisma model name to its real table. The defect was confined to `CLAUDE.md`.

**Fixed in this pass:** the four module rows and the two `lib/queries` rows in `CLAUDE.md` now name the real tables.

### 11. Stale reference to a route that does not exist — TRIVIAL

`lib/queries/activity.ts`'s header says the feed is "Read by `/api/v1/admin/activity`". There is no such route — `app/admin/activity/page.tsx` queries server-side and says so itself.

### 12. `.gitignore` silently swallows new files in `scripts/` — MEDIUM

`.gitignore:54` is `/scripts/*` ("# Scripts for my personal development"). Most existing files there are tracked because they were committed before the rule mattered — but **anything new added to `scripts/` is invisible to git**, with no warning.

Already affected on this branch:

| File | State |
|------|-------|
| `scripts/_check-admin-authority.ts` | **untracked** — the check guarding `app/admin/authority.ts` against `resolveAccess` drift exists only on this machine |
| `scripts/_check-role-taxonomy.ts` | **untracked** — same, for the role-taxonomy migration |

Both are real verification work that would be lost on a fresh clone, and neither would ever run in CI. This also bit this QA pass: the check runner and the lint ratchet were initially written to `scripts/` and had to be moved to **`tests/run-checks.ts`** and **`tests/lint-changed.mjs`** so they would actually be committed. `tests/run-checks.ts` now *skips* a listed check that isn't present rather than failing, so a partial checkout still runs what it has.

**Fix:** negate the files that should be shared — e.g.

```gitignore
/scripts/*
!/scripts/_check-*.ts
!/scripts/seed-permissions.ts
```

and `git add -f` the two untracked checks. Whether the genuinely personal scripts stay ignored is your call, but verification scripts that guard production logic belong in the repo.

---

## What is now guarded

| Area | Tests | File |
|------|-------|------|
| PO tolerance / auto-close boundaries | 7 | `tests/unit/po-rules.test.ts` |
| Agreed Final Costing formula | 10 | `tests/unit/final-costing.test.ts` |
| BOM RM/PM version diffing | 14 | `tests/unit/bom-version.test.ts` |
| Entity-scope helpers (unrestricted = no-op) | 14 | `tests/unit/scope.test.ts` |
| Mandatory remarks + PO quantity schemas | 12 | `tests/unit/validation.test.ts` |
| Goods receipt: increments, tolerance, over-receipt, status guards, audit rows | 14 | `tests/db/po-receive.test.ts` |
| Split: quantity conservation, approvals, the three defects above | 14 | `tests/db/po-split.test.ts` |
| Approval apply: archive-before-overwrite, absent fields, rollback | 8 | `tests/db/approval-apply.test.ts` |

Harness properties proven, not assumed:

- **Rollback works** — `purchase_orders` and `history_pos` row counts were identical (22 / 25) before and after two full `test:db` runs.
- **The prod guard fires** — `APP_ENV=prod npm run test:db` refuses every test before opening a connection.
- **The suite bites** — changing `poTolerance`'s cap from 100 to 1000 turns a test red; reverting it turns it green.

## Not covered by this pass

- Invoice inwarding end-to-end (Nanonets + Uniware + mail are external and metered) — covered by the manual checklist in [qa-uat-checklist.md](./qa-uat-checklist.md) and the existing `_check-inward-*` / `_check-uniware-*` scripts.
- Anything reached only through a route handler's own transaction — the rollback harness cannot wrap those. This is why the split math was extracted to `lib/po-split.ts`; the remaining route-owned transactions (masters `update` actions, the approve/reject route, `runInwardInvoice`) are untested at the integration level.
- React components and browser behaviour.
- The 238 pre-existing lint errors, by decision. `npm run lint:changed` stops the count growing.
