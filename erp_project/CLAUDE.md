@AGENTS.md

# ERP Project

Next.js 16 App Router · React 19 · TypeScript · Tailwind CSS v4 · Prisma 7 (schema only) · mysql2 · MariaDB (AWS RDS)

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
| `npm run db:test` | Verify DB connection |

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

### MariaDB ENUM columns

Status columns are `ENUM` in MariaDB. Inserting an unknown value **silently fails** (or errors in strict mode) and rolls back the transaction. When adding a new status value (e.g. `in_review`, `draft`) you must:

1. `ALTER TABLE <table> MODIFY COLUMN status ENUM('active', 'inactive', 'in_review', 'draft') DEFAULT 'active';`
2. Update the matching enum in `prisma/schema.prisma` to stay in sync.

### MariaDB nested transaction gotcha

Calling `conn.beginTransaction()` while a transaction is already open **implicitly commits the current transaction** in MariaDB (unlike PostgreSQL which would throw). This means any work done before the nested `BEGIN` is permanently committed even if you later call `rollback()`.

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
| `PO_BULK` | Bulk CSV PO upload | `purchase_orders` — parses S3 CSV and inserts each row as `raised` |

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
| `lib/queries/approvals.ts` | Approval workflow — insert, select, hasPending |
| `lib/queries/auth.ts` | Authentication — sessions, session history |
| `lib/queries/bom.ts` | BOM master — BOM, bom_details, bom_misc |
| `lib/queries/manufacturers.ts` | Manufacturer master — master_mfgs + details_mfg |
| `lib/queries/packing-materials.ts` | PM master — master_pm, pm_mrm, pm_vrm |
| `lib/queries/permissions.ts` | RBAC — page_permissions, user_page_permissions |
| `lib/queries/purchase-orders.ts` | Purchase orders — full CRUD, split, email, PDF, bulk CSV |
| `lib/queries/raw-materials.ts` | RM master — master_rm, rm_mrm, rm_vrm |
| `lib/queries/s3-files.ts` | S3 attachment operations — attachment_key on purchase_orders |
| `lib/queries/skus.ts` | SKU master — master_skus, sku_history |
| `lib/queries/vendors.ts` | Vendor master — master_vendors + details_vendor |

---

## App Pages / Modules

| Directory | Purpose |
|-----------|---------|
| `app/approvals/` | Approval queue — list, review, approve/reject |
| `app/masters/` | All master data pages (SKU, RM, PM, BOM, Vendor, Mfg) |
| `app/manufacturing/` | Manufacturing module |
| `app/inventory/` | Inventory tracking |
| `app/po-tracking/` | Purchase order tracking |
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
| `app/api/admin/permissions/route.ts` | Role-based page permission management |
| `app/api/admin/user-permissions/route.ts` | Per-user page permission overrides |
| `app/api/auth/[...nextauth]/route.ts` | NextAuth — Google OAuth |

---

## Important Paths

| Path | Purpose |
|------|---------|
| `prisma/schema.prisma` | Source of truth for DB schema (enums, column types) |
| `lib/db.ts` | mysql2 pool — `query`, `execute`, `pool` |
| `lib/constants.ts` | `STATUS` and `APPROVAL_STATUS` typed const objects |
| `lib/queries/` | SQL strings grouped by domain (see table above) |
| `lib/approvals/module-handlers.ts` | Strategy pattern — approval logic per module |
| `app/api/approvals/[id]/route.ts` | Approve / reject handler (uses MODULE_HANDLERS) |
| `app/api/approvals/entity/route.ts` | GET rejection info for edit dialogs |
| `types/masters.ts` | Row types for all master entities (Sku, Mfg, Vendor, RM, PM, BOM) |
| `docs/architecture.md` | Full architecture, data-flow diagrams, directory map |
| `docs/adding-a-new-module.md` | Step-by-step recipe for new modules |
| `docs/architecture-evolution.md` | Planned improvements (Zod, withGateway, request IDs) |
| `docs/api-reference.md` | API endpoint documentation |
| `docs/masters-module.md` | Masters data module details |
| `docs/authentication-and-permissions.md` | Auth and RBAC documentation |
| `docs/database-schema.md` | Database schema reference |
| `docs/frontend-patterns.md` | Frontend component patterns |
| `docs/getting-started.md` | Onboarding and setup guide |
