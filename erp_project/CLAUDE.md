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
| `npm run db:seed` | Seed `page_permissions` (`/admin`, `/approvals` deny-by-default rows) |
| `npm run db:test` | Verify DB connection (`SELECT NOW()`) |
| `npx prisma generate` | Regenerate Prisma client after schema changes |
| `npx prisma migrate dev --name <name>` | Create + apply a migration locally |
| `npx prisma migrate deploy` | Apply pending migrations in production/staging |
| `npx prisma db push` | Quick schema sync, no migration file (local dev only) |
| `npx prisma studio` | Open Prisma Studio |

There is **no `db:generate` / `db:migrate` / `db:push` / `db:studio` npm alias** — only `db:seed` and `db:test` are defined in `package.json`. Use the raw `npx prisma …` commands above for everything else. Restart the dev server after any `prisma migrate` or `prisma db push` to pick up schema changes. See `docs/environment-and-scripts.md` for the full env var and script reference.

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

### Prisma model names ≠ actual MariaDB table names

The Prisma schema uses different model names than the actual tables the app queries. **Always check `lib/queries/*.ts` for the real table names.**

| Prisma model | Actual MariaDB table |
|---|---|
| `skus` | `master_skus` |
| `vendors` | `master_vendors` |
| `vendor_details` | `details_vendor` |
| `mfgs` | `master_mfgs` |
| `mfg_details` | `details_mfg` |
| `rm` | `master_rm` |
| `pm` | `master_pm` |

### ENUM columns

Status columns are `ENUM` in MariaDB. Inserting an unknown value **silently fails** (or errors in strict mode) and rolls back the transaction. When adding a new status value (e.g. `in_review`, `draft`) you must:

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

`app/api/masters/skus/route.ts` → `update` action is the canonical pattern to copy.

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
| `RM_RATE` | RM × Mfg rate | `rm_mrm` + `rm_mrm_history` |
| `PM_RATE` | PM × Mfg rate | `pm_mrm` + history |
| `RM_VRM` | RM × Vendor rate | `rm_vrm` + `vrm_history` |
| `PM_VRM` | PM × Vendor rate | `pm_vrm` + `vrm_history` |
| `RM_MAT` | RM base record | `master_rm` |
| `PM_MAT` | PM base record | `master_pm` |
| `VENDOR` | Vendor master | `master_vendors` + `details_vendor` |
| `MFG` | Manufacturer master | `master_mfgs` + `details_mfg` |
| `PO` | Purchase Order (impromptu) | `purchase_orders` — status → `raised`; triggers email send on approval |
| `BOM` | BOM / Recipe master | `master_bom` + `details_bom` (+ `history_bom` snapshot) |
| `*_BULK` | One approval per uploaded CSV file | `PO_BULK`, `VENDOR_BULK`, `MFG_BULK`, `RM_BULK`, `PM_BULK`, `RM_VRM_BULK`, `RM_RATE_BULK`, `PM_VRM_BULK`, `PM_RATE_BULK`, `BOM_BULK` — the file is staged in S3 and inserted row-by-row in `applyAndArchive` on approval |

**Bulk uploads split by row kind.** `lib/master-routes/edit-match.ts` matches a CSV row to an existing record by **exact business-code match** (`code`, `rm_code`, `pm_code`); no code ⇒ new record. New-record rows go into the one `*_BULK` approval; rows recognised as edits are submitted **immediately as their own single-entity approval** (`RM_MAT`, `MFG`, …) so they get a real field-level diff and lock the entity to `in_review`.

**Master edits require `remarks`.** SKU, vendor, manufacturer and material-master update schemas carry `remarks: z.string().trim().min(1)`, archived to `history_masters_edits.remarks`. Rate edits archive `remarks` + `changed_by` to `history_vrm` / `history_mrm`.

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

To add a new module: add one object to `MODULE_HANDLERS` in that file. The route handler at `app/api/approvals/[id]/route.ts` picks it up automatically.

**Transaction rule:** Both methods receive an already-open `PoolConnection`. They must **not** call `beginTransaction`, `commit`, or `rollback` — that is the route handler's responsibility.

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
| Rejected | `rejected` | Amber banner with rejection reason (fetched from `/api/approvals/entity?module=X&entity_id=Y`), fields editable only by original submitter |

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

## lib/queries/ Files

| File | Domain |
|------|--------|
| `lib/queries/activity.ts` | `activity_log` insert + the `/admin > Activity` UNION feed (with `session_history`) |
| `lib/queries/approvals.ts` | Approval workflow — insert, select, hasPending |
| `lib/queries/auth.ts` | Authentication — sessions, session history |
| `lib/queries/bom.ts` | BOM master — BOM, bom_details, bom_misc |
| `lib/queries/entity-emails.ts` | Mail recipients per vendor / mfg / **warehouse** |
| `lib/queries/entity-scope.ts` | `user_entity_scope` + the admin picker's entity lists |
| `lib/queries/history.ts` | Generic per-module audit trail — `history_masters_edits` |
| `lib/queries/manufacturers.ts` | Manufacturer master — master_mfgs + details_mfg |
| `lib/queries/manufacturing.ts` | MFG Cost Manager — lines, misc costs, costing inputs |
| `lib/queries/packing-materials.ts` | PM master — master_pm, pm_mrm, pm_vrm |
| `lib/queries/permissions.ts` | Page access — page_permissions, user_page_permissions |
| `lib/queries/purchase-orders.ts` | Purchase orders — full CRUD, split, receive, email, PDF, bulk CSV, scope predicates |
| `lib/queries/raw-materials.ts` | RM master — master_rm, rm_mrm, rm_vrm |
| `lib/queries/s3-files.ts` | S3 attachment operations — attachment_key on purchase_orders |
| `lib/queries/sku-details.ts` | `sku_details` — fill weight, current BOM |
| `lib/queries/skus.ts` | SKU master — master_skus, sku_history |
| `lib/queries/supplier-invoices.ts` | `supplier_invoices` + `supplier_invoice_items` |
| `lib/queries/users.ts` | User administration — `users` + `user_roles` (the only writes to `users`) |
| `lib/queries/vendors.ts` | Vendor master — master_vendors + details_vendor |

---

## App Pages / Modules

| Directory | Purpose |
|-----------|---------|
| `app/admin/` | Admin panel — Users · Permissions · Data Access · Activity. Guarded once in `layout.tsx`; `authority.ts` mirrors `resolveAccess` for display |
| `app/approvals/` | Approval queue — list, review, approve/reject. Grouped into New / Edits / Bulk Uploads per module; `approval-card/` holds the card + per-shape diff renderers |
| `app/masters/` | All master data pages (SKU, RM, PM, BOM, Vendor, Mfg) |
| `app/manufacturing/` | MFG Cost Manager — `[mfgId]` has 7 tabs (SKUs, Misc. Cost, Approved Procurement Rates, Agreed Rates, Agreed Final Costing, + 2 placeholders) |
| `app/inventory/` | Inventory tracking |
| `app/po-tracking/` | Purchase order tracking — incl. `po-inwarding/` (goods receipt + Add Invoice) |
| `app/finance/` | Finance module |
| `app/sales-crm/` | Sales CRM |
| `app/hr-payroll/` | HR & Payroll |
| `app/reports/` | Reports |
| `app/actions/` | Server actions |
| `app/auth/` | Authentication pages |

---

## API Routes

| Route | Purpose |
|-------|---------|
| `app/api/masters/skus/` | SKU CRUD + export |
| `app/api/masters/raw-materials/` | RM CRUD + export |
| `app/api/masters/packing-materials/` | PM CRUD + export |
| `app/api/masters/material-master/` | Combined RM/PM view + export |
| `app/api/masters/vendors/` | Vendor CRUD + export |
| `app/api/masters/manufacturers/` | Manufacturer CRUD + export |
| `app/api/masters/bom-master/` | BOM CRUD + export (no approval flow) |
| `app/api/approvals/route.ts` | List pending approvals |
| `app/api/approvals/[id]/route.ts` | Approve / reject handler |
| `app/api/approvals/entity/route.ts` | GET rejection info for edit dialogs |
| `app/api/admin/users/route.ts` | User administration — POST create, PATCH update (no DELETE; deactivate instead) |
| `app/api/admin/permissions/route.ts` | Role page grants — GET / POST / DELETE (DELETE = "inherit") |
| `app/api/admin/user-permissions/route.ts` | Per-user page permission overrides |
| `app/api/admin/entity-scope/route.ts` | PUT — replaces one `(user, entity_type)` data-scope set |
| `app/api/purchase-orders/invoice/parse/route.ts` | Multipart PDF → Nanonets extraction (50–70 s; `maxDuration = 300`) |
| `app/api/purchase-orders/invoice/route.ts` | GET invoice history · POST commit (NDJSON step stream, always HTTP 200) |
| `app/api/purchase-orders/invoice/[id]/route.ts` | One invoice + its lines + the POs each resolved to |
| `app/api/purchase-orders/open-for-receive/route.ts` | Open POs for the per-line Reference PO picker |
| `app/api/files/preview/route.ts` | Server-side parse of a bulk-upload CSV/Excel → `{ headers, rows }` for the approval CSV preview |
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
| `lib/po-guard.ts` | `assertPoInScope` — required by every `/api/purchase-orders/[id]/**` route |
| `lib/admin-guards.ts` | `assertNotSelfLockout` / `assertNotSelfScope` — no UI recovery path exists for either |
| `lib/gateway/with-gateway.ts` | The route wrapper (auth, access, Zod, logging, `activity_log`) |
| `lib/invoice-inward.ts` | Supplier invoice → inward POs: S3 → DB → Uniware → email, ordered least-reversible-last |
| `lib/po-receive.ts` | Shared goods-receipt logic (tolerance, auto-close, `history_pos`) — takes an open connection, never opens its own transaction |
| `lib/costing/final-costing.ts` | The Agreed Final Costing formula, in one place |
| `lib/queries/` | SQL strings grouped by domain (see table above) |
| `lib/approvals/module-handlers.ts` | Strategy pattern — approval logic per module |
| `lib/master-routes/edit-match.ts` | "Is this CSV row an edit?" — exact business-code match only |
| `app/api/approvals/[id]/route.ts` | Approve / reject handler (uses MODULE_HANDLERS) |
| `app/api/approvals/entity/route.ts` | GET rejection info for edit dialogs |
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
