@AGENTS.md

# ERP Project

Next.js 16 App Router · React 19 · TypeScript · Tailwind CSS v4 · Prisma 7 (schema only) · mysql2 · MySQL 8.0 (AWS RDS)

> **Engine:** the RDS instance is **real MySQL 8.0**, not MariaDB (this file said MariaDB for a long time; the hand-written migrations in `prisma/*.sql` note the correction). The practical difference: **no `ADD COLUMN IF NOT EXISTS`**, so column-adding migrations are not re-runnable. The nested-transaction gotcha below still applies.

---

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start dev server |
| `npm run build` | Verify production build |
| `npm run lint` | Run ESLint |
| `npm run db:generate` | Regenerate Prisma client after schema changes |
| `npm run db:migrate` | Create + apply a migration |
| `npm run db:push` | Quick schema sync (local dev only) |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Seed permissions and sample data |
| `npm test` | Pure unit tests — money math, scope, schemas. No DB, no credentials, seconds. |
| `npm run test:db` | DB tests against `DB_NAME_TEST`, each wrapped in a transaction that is **always rolled back** |
| `npm run test:checks` | The older `scripts/_check-*.ts` scripts (`-- --db` to include the DB ones) |
| `npm run lint:changed` | ESLint on changed files only — the ratchet over ~238 pre-existing errors |
| `npx tsc --noEmit --incremental false` | The reliable type check. **Plain `npx tsc --noEmit` can report clean on a file that `next build` then rejects** — `tsconfig.json` sets `"incremental": true`, and a stale `tsconfig.tsbuildinfo` skips re-checking. `next build` always checks cold |
| `npm run build` | Won't run while `npm run dev` is up — Next 16 takes one lock on `.next` and answers "Another next build process is already running" |
| `npm run db:test` | Verify DB connection — ⚠️ **this script does not exist** (see `docs/qa-audit-2026-08.md` #9); nor do `db:generate`, `db:migrate`, `db:push`, `db:studio`, `db:seed` |

---

## Testing

**No test framework.** Node 24's built-in `node:test` + `node:assert/strict`, run through the existing `tsx` devDependency. Do not add vitest/jest.

| Path | What goes there |
|------|-----------------|
| `tests/unit/*.test.ts` | Pure logic only — no DB, no network, no credentials. Runs in CI. |
| `tests/db/*.test.ts` | Real SQL, wrapped in `withRollback()`. Never runs in CI. |
| `tests/helpers/db.ts` | `withRollback()` + fixture builders (`makePo`, `readForSplit`, `makeRmMfgRate`, …) |
| `scripts/_check-*.ts` | Pre-existing ad-hoc checks. Left as they are; run via `npm run test:checks`. |
| `tests/run-checks.ts`, `tests/lint-changed.mjs` | The check runner and lint ratchet. In `tests/`, **not** `scripts/`, because `.gitignore` has `/scripts/*` — new files there are silently untracked. |

Three things to know before writing a DB test:

1. **Import style** — use relative imports (`../../lib/po/po-receive`), not `@/`, matching the `_check-*` scripts.
2. **The env must be loaded by the runtime.** `lib/env.ts` reads `process.env` at module load, and your first `import` of anything under `lib/` evaluates it — so an `import "dotenv/config"` inside a test file runs too late. That's why `test:db` passes `--env-file-if-exists=.env`. Run DB tests via `npm run test:db`, never a bare `tsx --test`.
3. **Only connection-taking code is testable this way.** `withRollback` owns the transaction, and MySQL implicitly commits on a nested `beginTransaction()` — so a route handler (which opens its own) cannot be rolled back. Test the helper the route calls. This is why the split math was extracted to `lib/po-split.ts`, mirroring `lib/po-receive.ts`; **follow that pattern when adding logic worth testing.**

---

## Database Access — Critical Facts

### The right import

```ts
import { pool, query, execute } from "@/lib/db"
```

There is **no `db` export**. The three exports are:
- `query<T>(sql, params)` — for SELECT (uses `pool.query`, supports `? IS NULL` patterns)
- `execute(sql, params)` — for INSERT/UPDATE/DELETE (uses `pool.execute`, prepared statements)
- `pool` — for transactions that need `pool.getConnection()`

### Prisma is schema-only

**Prisma Client is never used at runtime.** Prisma is only for:
- Defining the DB structure (`prisma/schema.prisma`)
- Running migrations (`npm run db:migrate`)
- Browsing data (`npm run db:studio`)

All runtime DB calls go through `lib/db.ts` with raw SQL strings from `lib/queries/<domain>.ts`.

```ts
// CORRECT
import { query } from "@/lib/db"
import { vendors } from "@/lib/queries/vendors"
const rows = await query<Vendor>(vendors.selectPaginated, [...params])

// WRONG — never import this in application code
import { PrismaClient } from "@/app/generated/prisma"
```

### Prisma model names ≠ actual table names

The Prisma schema uses different model names than the actual tables the app queries. **Always check `lib/queries/*.ts` for the real table names.**

| Prisma model | Actual MySQL table |
|---|---|
| `skus` | `master_skus` |
| `vendors` | `master_vendors` |
| `vendor_details` | `details_vendor` |
| `mfgs` | `master_mfgs` |
| `mfg_details` | `details_mfg` |
| `rm` | `master_rm` |
| `pm` | `master_pm` |

> `prisma/schema.prisma` still carries the **pre-rename** model names for the
> tables below. It is schema-only and unused at runtime, so nothing breaks —
> but don't read it as the source of truth for a table name.

### The 2026-08 schema rename

The database was renamed underneath the app. Every query, type and route now uses
the right-hand column; the old names do not exist any more.

| Old | New |
|---|---|
| `master_bom` | `master_recipe` |
| `master_bom_mfg` | `master_recipe_mfg` |
| `details_bom` | `details_recipe` |
| `history_bom` | `history_recipe` |
| `bom_artifacts` | `artifacts_recipe` |
| `rm_mrm_fixed` / `pm_mrm_fixed` | `cost_master_rm_mfg` / `cost_master_pm_mfg` |
| `rm_vrm_dynamic` / `pm_vrm_dynamic` | `cost_master_rm_ven` / `cost_master_pm_ven` |
| `history_mrm` / `history_vrm` | `history_cost_mfg` / `history_cost_ven` |
| `supplier_invoices` / `supplier_invoice_items` | `invoice_mfg` / `invoice_items_mfg` |
| `sku_details` | `details_sku` |

**Columns moved too, but only some.** `bom_id` became `recipe_id` on
`purchase_orders`, `details_recipe`, `history_recipe`, `master_recipe_mfg` and
`artifacts_recipe`. These four deliberately **kept** their old names — a blanket
`bom` → `recipe` replace breaks them:

```
master_recipe.bom_code        master_skus.active_bom_id
details_sku.curr_bom_id       details_cost_ext_fixed.bom_detail_id
```

**`BOM` is still the module code.** `approvals.module` stores `'BOM'` and
`'BOM_BULK'` for existing rows, so `MODULE_HANDLERS`, `MODULE_LABEL`,
`MODULE_COLOR` and `entityLabelSql` are all keyed on `BOM`. Only the *label*
users read became "Recipe". Renaming the code needs a matching
`UPDATE approvals SET module = …` or those rows stop resolving to a handler.

> ⚠️ **`bom_misc` was never renamed** — it still carries its old name *and* its
> old `bom_id` column, and that is now deliberate. Every SELECT on it must
> therefore alias `bom_id AS recipe_id`, because all the TS row types and every
> caller key on `recipe_id`. `query<T>`/`timedQuery<T>` are unchecked casts, so a
> bare `bom_id` compiles, type-checks, lints — and then reads back `undefined`,
> which silently zeroed JW/Shrink/Shipper/Wastage on Agreed Final Costing and in
> the PO rate quote.

### `un_code_mfg_sku_wh_map` — the grain is not what the name says

In Unicommerce a **manufacturer is a vendor**, and a vendor's item catalog is scoped
to a **facility**. This table is that catalog:

**ONE ROW PER `(wh_id, mfg_id, sku_id)`**, enforced by `uq_wh_mfg_sku`. Three things
about it trip people up:

- **`wh_id` is `details_warehouse_entity.id` — a FACILITY** (location × legal
  entity), **not** `master_warehouse.id`. 18 active facilities over ~10 locations,
  because every site runs under both Pep and Kreative with a different Unicommerce
  facility *and a different vendor code*. Gurgaon is `GGN_WAREHOUSE` under Pep and
  `HYP_B2B_GGN` under Kreative.
- **`sku_id IS NULL` is the vendor-code row**: "this manufacturer is a Uniware vendor
  at this facility, under code X, with no SKUs mapped yet." Its existence is what
  makes a matrix cell mappable at all. **Every count over this table must exclude it**
  (`sku_id IS NOT NULL`), or each configured cell reads one SKU too high.
- **`un_mfg_code` repeats across a pair's rows**, on purpose — it mirrors a Vendor
  Item Master export row (`vendorCode`, `facility`, `itemTypeSku` on one line), so
  ingest is an upsert with no reshaping. Read it with `MAX()`; write it to every one
  of the pair's rows or the copies drift.

> ⚠️ `uq_wh_code (wh_id, un_mfg_code)` **used to be UNIQUE and was dropped** by
> `prisma/alter_un_code_mfg_sku_wh_map.sql` — it is incompatible with the per-SKU
> grain. It was the only thing stopping two manufacturers from claiming one Uniware
> vendor code at one facility, which makes POs and inwards land against the wrong
> ledger. That check now lives in application code only —
> `mfgFacilityMap.selectVendorCodeConflict`, called by
> `app/api/v1/manufacturing/facility-map/route.ts` — and is pinned by
> `tests/db/mfg-facility-map.test.ts`. Delete either and the hazard returns unguarded.

Reads go through the matrix on `/po-tracking/mfg-overview`; writes are **direct, with
no approval flow**, matching the parent relation (`master_recipe_mfg`, see
`app/api/v1/manufacturing/lines/route.ts:5`).

### ENUM columns

Status columns are `ENUM` in MySQL. Inserting an unknown value **silently fails** (or errors in strict mode) and rolls back the transaction. When adding a new status value (e.g. `in_review`, `draft`) you must:

1. `ALTER TABLE <table> MODIFY COLUMN status ENUM('active', 'inactive', 'in_review', 'draft') DEFAULT 'active';`
2. Update the matching enum in `prisma/schema.prisma` to stay in sync.

### Nested transaction gotcha

Calling `conn.beginTransaction()` while a transaction is already open **implicitly commits the current transaction** in MySQL/MariaDB (unlike PostgreSQL, which would throw). This means any work done before the nested `BEGIN` is permanently committed even if you later call `rollback()`.

**Rule:** Only call `beginTransaction / commit / rollback` in the route handler. Never inside helper functions or module handlers.

---

## Approval Flow

Edits to master records go through a structured approval workflow instead of writing directly to the DB.

### How it works

1. User submits an edit → API computes a field-level diff
2. An `approvals` record + `approval_items` rows (one per changed field) are inserted
3. The entity's `status` is set to `in_review` (locking it from further edits)
4. An approver visits `/approvals`, reviews the diff, and approves or rejects
5. **On approve:** `applyAndArchive` in the module handler applies the diff and sets status to `active`
6. **On reject:** `setStatus` sets status to `draft`; the original submitter can re-edit

### Reference implementation

`app/api/v1/masters/skus/route.ts` → `update` action is the canonical pattern to copy.

```ts
// Approval submission pattern (copy this exactly)
const pending = await query(approvalsSql.hasPending, ["MODULE_CODE", entityId])
if (pending.length > 0) return NextResponse.json({ error: "..." }, { status: 409 })

const conn = await pool.getConnection()
await conn.beginTransaction()
try {
  const [rows] = await conn.execute(sql.selectById, [entityId])
  const current = (rows as any[])[0]

  const diff = Object.entries(proposed).filter(
    ([k, v]) => String(current[k] ?? "") !== String(v ?? "")
  )
  if (diff.length === 0) { await conn.rollback(); return NextResponse.json({ ok: true }) }

  const [ar] = await conn.execute(approvalsSql.insertApproval, [userId, "MODULE_CODE", entityId])
  for (const [field, newVal] of diff) {
    await conn.execute(approvalsSql.insertApprovalItem, [ar.insertId, field, String(current[field] ?? ""), String(newVal)])
  }
  await conn.execute(sql.setStatus, ["in_review", entityId])
  await conn.commit()
  return NextResponse.json({ ok: true, approval_id: ar.insertId })
} catch (err: any) {
  await conn.rollback()
  return NextResponse.json({ error: "Database error" }, { status: 500 })
} finally { conn.release() }
```

### Currently registered modules

| Module code | Entity | Tables touched by applyAndArchive |
|---|---|---|
| `SKU` | SKU master | `master_skus` (audit trail: `history_masters_edits`, module=`SKU` — not `sku_history`, which is legacy/unused) |
| `RM_RATE` | RM × Mfg rate | `cost_master_rm_mfg` + `history_cost_mfg` |
| `PM_RATE` | PM × Mfg rate | `cost_master_pm_mfg` + `history_cost_mfg` |
| `RM_VRM` | RM × Vendor rate | `cost_master_rm_ven` + `history_cost_ven` |
| `PM_VRM` | PM × Vendor rate | `cost_master_pm_ven` + `history_cost_ven` |
| `RM_MAT` | RM base record | `master_rm` |
| `PM_MAT` | PM base record | `master_pm` |
| `VENDOR` | Vendor master | `master_vendors` + `details_vendor` |
| `MFG` | Manufacturer master | `master_mfgs` + `details_mfg` |
| `PO` | Purchase Order (impromptu) | `purchase_orders` — status → `raised`; triggers email send on approval |
| `BOM` | Recipe master (module code stays `BOM`) | `master_recipe` + `details_recipe` (+ `history_recipe` snapshot) |
| `MFG_MISC` | Per-SKU JW / Shrink Wrap / Shipper / Wastage % | `bom_misc`. **New lines are INSERTed straight away as `in_review`** rather than staged — there is no prior row to lock. Safe because every costing query filters `status = 'active'`, so an `in_review` row prices nothing. Approve flips it to the submitted status (default `active`); reject sets `rejected`. |
| `*_BULK` | One approval per uploaded CSV file | `PO_BULK`, `VENDOR_BULK`, `MFG_BULK`, `RM_BULK`, `PM_BULK`, `RM_VRM_BULK`, `RM_RATE_BULK`, `PM_VRM_BULK`, `PM_RATE_BULK`, `BOM_BULK`, `MFG_MISC_BULK` — the file is staged in S3 and inserted row-by-row in `applyAndArchive` on approval. `entity_id` is the uploader's user id, except `MFG_MISC_BULK` which passes the **manufacturer** (`stageBulkUploadApproval`'s optional `entityId`), since the handler needs it to resolve each row's `sku_code` |

**Bulk uploads split by row kind.** `lib/master-routes/edit-match.ts` matches a CSV row to an existing record by **exact business-code match** (`code`, `rm_code`, `pm_code`); no code ⇒ new record. New-record rows go into the one `*_BULK` approval; rows recognised as edits are submitted **immediately as their own single-entity approval** (`RM_MAT`, `MFG`, …) so they get a real field-level diff and lock the entity to `in_review`.

**Master edits require `remarks`.** SKU, vendor, manufacturer and material-master update schemas carry `remarks: z.string().trim().min(1)`, archived to `history_masters_edits.remarks`. Rate edits archive `remarks` + `changed_by` to `history_cost_ven` / `history_cost_mfg`.

**Invoice inwarding** (`/po-tracking/po-inwarding` → Add Invoice) does **not** go through the approval flow — it commits directly through `lib/invoice-inward.ts`. See `docs/po-inwarding.md`.

---

## Strategy Pattern — Module Handlers

`lib/approvals/module-handlers.ts` uses the **Strategy pattern** so the approve/reject route never changes when a new module is added.

```ts
export interface ModuleHandler {
  setStatus(conn: PoolConnection, entityId: number, status: string): Promise<void>
  applyAndArchive(conn: PoolConnection, entityId: number, items: DiffItem[], approverId: number): Promise<void>
}
```

To add a new module: add one object to `MODULE_HANDLERS` in that file. The route handler at `app/api/v1/approvals/[id]/route.ts` picks it up automatically.

**Transaction rule:** Both methods receive an already-open `PoolConnection`. They must **not** call `beginTransaction`, `commit`, or `rollback` — that is the route handler's responsibility.

---

## Shared Table Primitives

Built during the 2026-08 work; prefer these over hand-rolling a table.

| Component | Use |
|---|---|
| `components/masters/DataTable.tsx` | The masters table: sortable headers + body generated from one `ColumnDef[]`, so the two can't drift. Exports `useTableSort` and the `ColumnDef` / `AnyRow` types. Used by Material Master and both Cost Masters. |
| `components/ui/empty-state.tsx` | Two shapes, both live: `EmptyState` (copy only — caller owns the row) and `TableEmpty` (whole `<TableRow>` + optional action). |
| `components/ui/scroll-fade.tsx` | Scroll container that keeps the scrollbar hidden but draws an edge fade + chevron while there is more content — the scrollbar is otherwise the only "there is more" cue. |
| `components/ui/sortable-table-head.tsx` | `SortableTableHead` / `StaticTableHead`. `overflow-hidden` on the head is load-bearing: under `table-layout: fixed` a long label otherwise paints over its neighbour. |

`DataTable` sets a computed `min-width` (declared column widths + 140px per
flexible column). Without it, `table-fixed` + `w-full` squeezes columns toward
zero on zoom instead of letting the container scroll.

---

## Status Constants

Use the typed constants from `lib/constants.ts` instead of raw string literals:

```ts
import { STATUS, APPROVAL_STATUS } from "@/lib/constants"

STATUS.ACTIVE     // "active"
STATUS.DRAFT      // "draft"
STATUS.IN_REVIEW  // "in_review"
STATUS.INACTIVE   // "inactive"

APPROVAL_STATUS.PENDING   // "pending"
APPROVAL_STATUS.APPROVED  // "approved"
APPROVAL_STATUS.REJECTED  // "rejected"
```

Typos in status strings become compile errors instead of silent runtime bugs.

---

## Approval-Aware Edit Dialogs

Dialogs for entities that go through the approval flow must handle three states:

| State | `status` value | UI behaviour |
|---|---|---|
| Normal | `active` / `inactive` / etc. | Fields editable, button says "Submit for Approval" |
| Locked | `in_review` | Blue banner shown, all fields disabled, Save button hidden |
| Rejected | `rejected` | Amber banner with rejection reason (fetched from `/api/v1/approvals/entity?module=X&entity_id=Y`), fields editable only by original submitter |

Reference implementations: `app/masters/vendors/EditVendorDialog.tsx`, `app/masters/manufacturers/EditMfgDialog.tsx`.

---

## PoolConnection Typing

When working with transactions, type the connection explicitly:

```ts
import type { PoolConnection } from "mysql2/promise"

const conn: PoolConnection = await pool.getConnection()
```

This eliminates `any` type noise and gives full IntelliSense on `conn.execute`, `conn.beginTransaction`, etc.

---

## PO Tracking — the rules that bite

**Displayed status ≠ stored status.** `DISPLAY_STATUS_EXPR` reads a stored-`raised` PO with no `email_sent_at` back as **Draft** — a PO the manufacturer hasn't been told about isn't really raised. That derived value is what the tabs filter on and what the table badges, so "is this a draft?" has one answer, `isDraftPo()` in `lib/po-rules.ts`, and both the UI and the API must use it. `raw_status` is the stored value, and only gates actions the API validates against it (the edit action).

| Rule | Where |
|---|---|
| **A draft cannot be split** — split divides an order the manufacturer already has; before the mail goes out there is nothing to divide, change the quantity instead. Covers raised-but-unmailed, not just stored `draft` | `PoDataRow.canSplit` + the 409 in `[id]/split/route.ts`. The UI hiding a button is never the guard — PO ids are guessable integers |
| **No manual receive on the inwarding desk** — receipts there come from the invoice (Add Invoice), which books quantity, batch and document together | `PoDataRow.canReceive`, gated on `inwardingMode`. Procurement keeps its Receive |
| **Tabs** — FG tracking leads with `all` then `open`; `open` is a pseudo-status spanning `raised` + `punched` + `partially_received`, expanded by `statusMatchValues()` and never stored. Its badge is summed client-side | `po-types.ts` `TABS` / `INWARD_TABS`, `po-procurement/page.tsx` |
| **Split children** are never rows of their own — reached by expanding the master, and highlighted with it as one block. `IS_SPLIT_CHILD` exempts inward POs, so an inward PO's `reference_po` doesn't hide it from the list | `MASTERS_ONLY`, `lib/po-children.ts`, `PoDataRow` |
| **Row menus must be portalled.** The table sits in an `overflow-auto` wrapper, so an `absolute` dropdown is clipped — invisible on a full page, obvious on a one-row table | `PoActionMenu`, same pattern as `components/ui/FuzzySelect` |

> `lib/po-split.ts` is a parallel implementation used only by its own DB test, and it has drifted (it still shrinks the parent's `qty`, which the split route deliberately stopped doing). **The route is the production path.**

## lib/queries/ Files

| File | Domain |
|------|--------|
| `lib/queries/activity.ts` | `activity_log` insert + the `/admin > Activity` UNION feed (with `session_history`) |
| `lib/queries/approvals.ts` | Approval workflow — insert, select, hasPending |
| `lib/queries/auth.ts` | Authentication — sessions, session history |
| `lib/queries/recipe.ts` | Recipe master — `master_recipe`, `details_recipe`, `artifacts_recipe` (was `bom.ts`) |
| `lib/queries/entity-emails.ts` | Mail recipients per vendor / mfg / **warehouse** / **employee**, each row a `to` or a `cc`. An employee row is anyone worth looping in — ours or an outside party (3PL, CHA), so the address is typed, never picked from `users`. Its `entity_code` is the warehouse name or mfg code it hangs off, or `'*'` for **every** manufacturer including future ones |
| `lib/queries/entity-scope.ts` | `user_entity_scope` + the admin picker's entity lists |
| `lib/queries/history.ts` | Generic per-module audit trail — `history_masters_edits` |
| `lib/queries/manufacturers.ts` | Manufacturer master — master_mfgs + details_mfg |
| `lib/queries/manufacturing.ts` | MFG Cost Manager — lines, misc costs, costing inputs |
| `lib/queries/mfg-facility-map.ts` | `un_code_mfg_sku_wh_map` — the MFG × facility × SKU catalog mirrored to Uniware (see the note below) |
| `lib/queries/packing-materials.ts` | PM master — master_pm, cost_master_pm_mfg, cost_master_pm_ven |
| `lib/queries/permissions.ts` | Page access — page_permissions, user_page_permissions |
| `lib/queries/purchase-orders.ts` | Purchase orders — full CRUD, split, receive, email, PDF, bulk CSV, scope predicates |
| `lib/queries/raw-materials.ts` | RM master — master_rm, cost_master_rm_mfg, cost_master_rm_ven |
| `lib/queries/s3-files.ts` | S3 attachment operations — attachment_key on purchase_orders |
| `lib/queries/sku-details.ts` | **Not** the `details_sku` table — reads `mcaff_dwh.All_Product_Name_MRP_Mapping` via `queryDwh` (`lib/db-sku.ts`). Filename is historical. |
| `lib/queries/skus.ts` | SKU master — master_skus, sku_history |
| `lib/queries/supplier-invoices.ts` | `invoice_mfg` + `invoice_items_mfg` — list/detail/export, scoped by mfg + destination |
| `lib/queries/users.ts` | User administration — `users` + `user_roles` (the only writes to `users`) |
| `lib/queries/vendors.ts` | Vendor master — master_vendors + details_vendor |

---

## App Pages / Modules

| Directory | Purpose |
|-----------|---------|
| `app/admin/` | Admin panel — Users · Permissions · Data Access · Activity. Guarded once in `layout.tsx`; `authority.ts` mirrors `resolveAccess` for display |
| `app/approvals/` | Approval queue — list, review, approve/reject. Grouped into New / Edits / Bulk Uploads per module; `approval-card/` holds the card + per-shape diff renderers |
| `app/masters/` | All master data pages (SKU, RM, PM, **Recipe**, Vendor, Mfg). Recipe lives at `recipe-master/` and the slug is `/masters/recipe-master` — renamed from `bom-master`, with the matching `page_permissions` row migrated. |
| `app/manufacturing/` | MFG Cost Manager — `[mfgId]` has 7 tabs (SKUs, Misc. Cost, Approved Procurement Rates, Agreed Rates, Agreed Final Costing, + 2 placeholders) |
| `app/inventory/` | Inventory tracking |
| `app/po-tracking/` | Purchase order tracking — `po-procurement/` (FG POs), `po-inwarding/` (goods receipt + Add Invoice), and `invoices/` (every supplier invoice with its lines; shares `InvoiceGroupTable` with the inwarding desk's history dialog) |
| `app/finance/` | Finance module |
| `app/sales-crm/` | Sales CRM |
| `app/hr-payroll/` | HR & Payroll |
| `app/reports/` | Reports |
| `app/actions/` | Server actions |
| `app/auth/` | Authentication pages |

---

## API Routes

**Everything lives under `/api/v1/`** as of 2026-08-07 — except two routes that
external systems point at by URL and therefore could not move:

| Stays unversioned | Why |
|---|---|
| `/api/auth/[...nextauth]` | the redirect URI registered in Google Cloud Console |
| `/api/health` | the ALB target-group health-check path (`deploy/setup-commands.md`) |

A new major version is a sibling directory (`app/api/v2/...`), not a rewrite of
v1. **Outbound** URLs are not ours to version: `lib/nanonets/endpoints.ts` calls
Nanonets' own `/api/v2/`, and a repo-wide find-replace on `"/api/"` once rewrote
it to `/api/v1/v2/` — a 404 that compiled, linted and type-checked.
`tests/unit/nanonets-endpoints.test.ts` now pins it.

| Route | Purpose |
|-------|---------|
| `app/api/v1/masters/skus/` | SKU CRUD + export |
| `app/api/v1/masters/raw-materials/` | RM CRUD + export |
| `app/api/v1/masters/packing-materials/` | PM CRUD + export |
| `app/api/v1/masters/material-master/` | Combined RM/PM view + export |
| `app/api/v1/masters/vendors/` | Vendor CRUD + export |
| `app/api/v1/masters/manufacturers/` | Manufacturer CRUD + export |
| `app/api/v1/masters/recipe-master/` | Recipe CRUD + export — **does** use the approval flow (module code `BOM`) |
| `app/api/v1/manufacturing/facility-map/route.ts` | MFG × facility SKU mapping — `set-map` replaces one cell's SKU set, `set-vendor-code` sets the pair's Uniware vendor code. Direct write, no approval |
| `app/api/v1/approvals/route.ts` | List pending approvals |
| `app/api/v1/approvals/[id]/route.ts` | Approve / reject handler |
| `app/api/v1/approvals/entity/route.ts` | GET rejection info for edit dialogs |
| `app/api/v1/admin/users/route.ts` | User administration — POST create, PATCH update (no DELETE; deactivate instead) |
| `app/api/v1/admin/permissions/route.ts` | Role page grants — GET / POST / DELETE (DELETE = "inherit") |
| `app/api/v1/admin/user-permissions/route.ts` | Per-user page permission overrides |
| `app/api/v1/admin/entity-scope/route.ts` | PUT — replaces one `(user, entity_type)` data-scope set |
| `app/api/v1/purchase-orders/invoice/parse/route.ts` | Multipart PDF → Nanonets extraction (50–70 s; `maxDuration = 300`) |
| `app/api/v1/purchase-orders/invoice/route.ts` | GET invoice history · POST commit (NDJSON step stream, always HTTP 200) |
| `app/api/v1/purchase-orders/invoice/[id]/route.ts` | One invoice + its lines + the POs each resolved to |
| `app/api/v1/purchase-orders/open-for-receive/route.ts` | Open POs for the per-line Reference PO picker |
| `app/api/v1/files/preview/route.ts` | Server-side parse of a bulk-upload CSV/Excel → `{ headers, rows }` for the approval CSV preview |
| `app/api/auth/[...nextauth]/route.ts` | NextAuth — Google OAuth |

**All routes go through `withGateway`** (`lib/gateway/with-gateway.ts`): session → `access: { pageSlug, level }` → Zod → handler, error shape `{ error, code, details?, requestId }`, plus an `activity_log` row on every non-GET. Throw `ApiError(status, code, message)` for user-facing failures.

**Entity scope is opt-in per route**, not part of `access`. A route that takes an id must call `assertInScope(scope, type, id)` — or `assertPoInScope(userId, poId)` for POs, since PO ids are guessable integers.

---

## Important Paths

| Path | Purpose |
|------|---------|
| `prisma/schema.prisma` | Source of truth for DB schema (enums, column types) |
| `prisma/*.sql` | Hand-written migrations applied straight to RDS, each with a header explaining what/why/re-runnable. Run on **both** schemas and keep `schema.prisma` in sync. |
| `lib/db.ts` | mysql2 pool — `query`, `execute`, `pool` |
| `lib/constants.ts` | `STATUS` and `APPROVAL_STATUS` typed const objects |
| `lib/pages.ts` | Canonical permission-controlled page slugs — the admin grid, sidebar locks and breadcrumbs all read this |
| `lib/roles.ts` | The declared role taxonomy: `developer`, `admin`, and `{rm,pm,production,cost}_{head,lead,executive}`. Nothing branches on a role name — a role's only power is its `page_permissions` rows |
| `lib/scope.ts` | Per-user entity scope. **Absence of rows = UNRESTRICTED.** `scopeClause`/`scopeParams` need `query()` (array expansion), `assertInScope` for anything addressed by id |
| `lib/po-guard.ts` | `assertPoInScope` — required by every `/api/v1/purchase-orders/[id]/**` route |
| `lib/admin-guards.ts` | `assertNotSelfLockout` / `assertNotSelfScope` — no UI recovery path exists for either |
| `lib/gateway/with-gateway.ts` | The route wrapper (auth, access, Zod, logging, `activity_log`) |
| `lib/invoice-inward.ts` | Supplier invoice → inward POs: S3 → DB → Uniware → email, ordered least-reversible-last |
| `lib/invoice-merge.ts` | `mergeInwardLinesBySku` — ONE inward PO per SKU, mirroring `mergeItemsBySku` in `lib/uniware.ts` so our POs and Uniware's items line up 1:1 |
| `lib/recipients.ts` | `splitRecipients` — `entity_emails` rows → `{ to, cc }`, deduped with To winning over CC |
| `lib/mail-limits.ts` | Outbound attachment size ceiling |
| `lib/pdf/po-letterhead.ts` | Who a PO is FROM and where it ships: `sku_code → brand → entity`, with the fallback ladder. `po-document.tsx` renders every entity from it — there is no per-entity template |
| `lib/po-rules.ts` | `poTolerance` (when a PO is closed out) and `isDraftPo` (draft **as PO Tracking means it** — stored `draft`, or `raised` with no `email_sent_at`) |
| `lib/brand-view.ts` / `lib/brand-guard.ts` | Brand as an access boundary: the GRANT (`user_entity_scope`) vs the currently-VIEWED set, kept apart — conflating them is privilege escalation. Reads filter in SQL, writes go through the guard |
| `lib/po-receive.ts` | Shared goods-receipt logic (tolerance, auto-close, `history_pos`) — takes an open connection, never opens its own transaction |
| `lib/costing/final-costing.ts` | The Agreed Final Costing formula, in one place |
| `lib/queries/` | SQL strings grouped by domain (see table above) |
| `lib/approvals/module-handlers.ts` | Strategy pattern — approval logic per module |
| `lib/master-routes/edit-match.ts` | "Is this CSV row an edit?" — exact business-code match only |
| `app/api/v1/approvals/[id]/route.ts` | Approve / reject handler (uses MODULE_HANDLERS) |
| `app/api/v1/approvals/entity/route.ts` | GET rejection info for edit dialogs |
| `types/masters.ts` | Row types for all master entities (Sku, Mfg, Vendor, RM, PM, BOM) |
| `docs/architecture.md` | Full architecture, data-flow diagrams, directory map |
| `docs/admin-and-data-scoping.md` | Admin panel, role taxonomy, per-user entity scope, activity trail |
| `docs/po-inwarding.md` | Invoice inwarding: Nanonets → review → inward POs → Uniware → warehouse mail |
| `docs/adding-a-new-module.md` | Step-by-step recipe for new modules |
| `docs/architecture-evolution.md` | Planned improvements (Zod, withGateway, request IDs) |
| `docs/api-reference.md` | API endpoint documentation |
| `docs/masters-module.md` | Masters data module details |
| `docs/authentication-and-permissions.md` | Auth and RBAC documentation |
| `docs/database-schema.md` | Database schema reference |
| `docs/frontend-patterns.md` | Frontend component patterns |
| `docs/getting-started.md` | Onboarding and setup guide |
