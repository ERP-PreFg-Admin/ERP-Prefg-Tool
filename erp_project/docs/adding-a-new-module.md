# Adding a New Module

> **Related docs:** [Architecture](./architecture.md) · [Masters Module](./masters-module.md) · [Frontend Patterns](./frontend-patterns.md) · [Authentication & Permissions](./authentication-and-permissions.md) · [Architecture Evolution](./architecture-evolution.md)

This is the step-by-step recipe for building a new ERP module. It uses the **Masters module as the reference implementation** — copy from there rather than inventing new patterns.

Before starting, also read [Architecture Evolution](./architecture-evolution.md) — new modules should eventually adopt the `withGateway()` wrapper and event-driven service pattern described there.

---

## Step 0 — Define the Scope

Answer these before writing code:
1. What tables does this module own? Are they already in `prisma/schema.prisma`?
2. What page slug will it use? (e.g. `/inventory`)
3. Which roles need access, and at what level?

---

## Step 1 — Add Database Tables

If the tables don't exist yet:

**1.1 Add model(s) to `prisma/schema.prisma`**

Follow the existing naming conventions (see [Database Schema — Naming Conventions](./database-schema.md#naming-conventions)):

```prisma
model inventory_items {
  id          Int      @id @default(autoincrement())
  item_code   String   @unique
  name        String
  quantity    Decimal
  location    String?
  status      inventory_items_status @default(active)
  created_at  DateTime @default(now())
  created_by  Int?
  users       users?   @relation(fields: [created_by], references: [id])
}

enum inventory_items_status {
  active
  inactive
}
```

**1.2 Create and apply the migration**

```bash
npx prisma migrate dev --name add-inventory-items
```

**1.3 Add SQL query strings to `lib/queries/<module>.ts`**

Use `lib/queries/vendors.ts` as a template:

```ts
// lib/queries/inventory.ts
export const inventory = {
  selectAll: `
    SELECT id, item_code, name, quantity, location, status, created_at
    FROM inventory_items
    ORDER BY item_code ASC
  `,
  insert: `
    INSERT INTO inventory_items (item_code, name, quantity, location, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
};
```

**1.4 Add TypeScript row types to `types/`**

Mirror the SELECT columns exactly:

```ts
// types/inventory.ts
export type InventoryItem = {
  id: number;
  item_code: string;
  name: string;
  quantity: number;
  location: string | null;
  status: string;
  created_at: string;
};
```

---

## Step 2 — Build the API Route

**2.1 Create `app/api/<module>/route.ts`**

Copy `app/api/masters/skus/route.ts` as a template. Required pattern:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { execute, query } from "@/lib/db";
import { inventory } from "@/lib/queries/inventory";

export async function POST(req: Request) {
  // 1. Auth check — always first
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { action } = body;

  // 2. Action dispatch
  if (action === "create") {
    const { item_code, name, quantity } = body;
    if (!item_code?.trim() || !name?.trim()) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    try {
      const res = await execute(inventory.insert, [item_code, name, quantity, body.location ?? null, body.status ?? "active", Number(session.user.id)]);
      return NextResponse.json({ id: res.insertId });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ER_DUP_ENTRY") {
        return NextResponse.json({ error: "Item code already exists" }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: "Database error: " + message }, { status: 500 });
    }
  }

  if (action === "bulk") {
    // ... bulk insert pattern (see app/api/masters/skus/route.ts)
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
```

For **multi-table writes** (like vendors which also insert into `vendor_details`), use a transaction:

```ts
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const [result] = await conn.execute("INSERT INTO ...", [...]);
  await conn.execute("INSERT INTO ...", [result.insertId, ...]);
  await conn.commit();
  return NextResponse.json({ id: (result as any).insertId });
} catch (err: unknown) {
  await conn.rollback();
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: "Database error: " + message }, { status: 500 });
} finally {
  conn.release();
}
```

**2.2 Register the module in the approval handler (if it needs approvals)**

If records in this module go through the edit-approval flow, add a handler object to `lib/approvals/handlers/<domain>.ts` — handlers are split by domain (`sku.ts`, `raw-materials.ts`, `packing-materials.ts`, `vendors.ts`, `manufacturers.ts`, `purchase-orders.ts`, `bom.ts`), mirroring `lib/queries/`'s layout. Create a new domain file (e.g. `lib/approvals/handlers/inventory.ts`) if the module doesn't fit an existing one. Each handler implements two methods (the shared `ModuleHandler`/`DiffItem` types and `buildFieldMap`/`s3KeyOf` helpers live in `lib/approvals/handlers/types.ts`):

| Method | Called when | What it does |
|--------|------------|--------------|
| `setStatus(conn, entityId, status)` | Approval **rejected** | Reverts the entity to `STATUS.DRAFT` so the submitter can re-edit |
| `applyAndArchive(conn, entityId, items, approverId)` | Approval **approved** | Archives the old snapshot to the history table, applies the diff, restores status to `STATUS.ACTIVE` |

Both methods receive the caller's open `PoolConnection` — **do not call `beginTransaction`, `commit`, or `rollback` inside them**; the route handler owns the transaction.

```ts
// lib/approvals/handlers/inventory.ts — the handler logic lives here, per domain

import { inventory as inventorySql } from "@/lib/queries/inventory"
import { STATUS } from "@/lib/constants"
import { buildFieldMap, type ModuleHandler } from "./types"

export const inventoryHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(inventorySql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(inventorySql.selectById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`Inventory item ${entityId} not found`)

    // Archive old snapshot if the module has a history table, then apply diff:
    await conn.execute(inventorySql.update, [
      fieldMap.name     ?? cur.name,
      fieldMap.quantity ?? cur.quantity,
      fieldMap.status   ?? STATUS.ACTIVE,
      entityId,
    ])
  },
}
```

```ts
// lib/approvals/module-handlers.ts — import the new handler and register it
// in MODULE_HANDLERS; this top-level file only wires domain handlers together,
// it doesn't contain any handler logic itself

import { inventoryHandler } from "./handlers/inventory"

export const MODULE_HANDLERS: Record<string, ModuleHandler> = {
  // existing entries …
  INVENTORY: inventoryHandler,   // ← add this line
}
```

Then in the API route that submits edits for approval, use the shared `approvalsSql.insertApproval` + `approvalsSql.insertApprovalItem` queries with your module code (`"INVENTORY"`), exactly like `app/api/masters/skus/route.ts` does with `"SKU"`. The approve/reject route (`app/api/approvals/[id]/route.ts`) picks up the new handler automatically.

Also add the required SQL helpers (`setStatus`, `selectById`, `update`) to `lib/queries/<module>.ts` — the `RM_MAT` and `PM_MAT` entries in `lib/approvals/handlers/raw-materials.ts` / `packing-materials.ts` are the simplest reference implementations.

**Bulk CSV variant:** if the module also needs a bulk upload (see `RM_BULK`, `PM_BULK`, `VENDOR_BULK`, `MFG_BULK`, `BOM_BULK`, `PO_BULK` in the registry), register a second `<MODULE>_BULK` handler in the same domain file. Its `applyAndArchive` parses the uploaded file from S3 via `parseS3Import` (using `s3KeyOf(items, "<MODULE>_BULK")` from `types.ts` to pull the staged file's S3 key out of the approval items) and inserts one row per valid CSV row, skipping and reporting invalid ones — see `lib/approvals/handlers/bom.ts`'s `bomBulkHandler` for the fullest example, including per-group partial success.

**History/audit trail:** if the module should show up on its master page's history view, call `insertHistoryEntry` (from `lib/master-routes/history-utils.ts`) alongside the approval insert when submitting an edit — the shared approve/reject route resolves the pending row automatically via `resolvePendingHistoryEntry`. See `app/api/masters/vendors/history/route.ts` or `raw-materials/mrm-history` for reference read-side implementations.

**2.3 Seed permissions for the new page slug**

Add entries to the `matrix` array in `scripts/seed-permissions.ts`:

```ts
{ role: "developer", page_slug: "/inventory", access_level: "editor" },
{ role: "production_operations", page_slug: "/inventory", access_level: "viewer" },
// ... other roles
```

Then run:
```bash
npm run db:seed
```

---

## Step 3 — Build the Server Page

**3.1 Create `app/<module>/page.tsx`**

Copy `app/masters/skus/page.tsx` as a template:

```ts
import { auth } from "@/lib/auth";
import { resolveAccess } from "@/lib/permissions";
import { query } from "@/lib/db";
import { redirect } from "next/navigation";
import { InventoryClient } from "./InventoryClient";
import type { InventoryItem } from "@/types/inventory";

export default async function InventoryPage() {
  const session = await auth();
  if (!session) redirect("/auth/signin");

  const userId = Number(session.user.id);
  const access = await resolveAccess(userId, session.user.roles, "/inventory");
  if (access === "none") redirect("/auth/unauthorized");

  const items = await query<InventoryItem>(
    "SELECT id, item_code, name, quantity, location, status, created_at FROM inventory_items ORDER BY item_code ASC"
  );

  return <InventoryClient initialItems={items} access={access} />;
}
```

Pass `access` to the Client Component so it can conditionally show/hide edit controls for `"viewer"` vs `"editor"`.

---

## Step 4 — Build the Client Component

**4.1 Create `app/<module>/InventoryClient.tsx`**

Use `app/masters/skus/SkusClient.tsx` as a template:

```ts
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MasterToolbar } from "@/components/masters/MasterToolbar";
import { AddRecordDialog } from "@/components/masters/AddRecordDialog";
import { SearchInput } from "@/components/masters/SearchInput";
import type { InventoryItem } from "@/types/inventory";

export function InventoryClient({
  initialItems,
  access,
}: {
  initialItems: InventoryItem[];
  access: "viewer" | "editor";
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  const filtered = initialItems.filter((item) =>
    [item.item_code, item.name].some((v) => v?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <MasterToolbar
        onSearch={setSearch}
        addButton={
          access === "editor" ? (
            <AddRecordDialog
              entityLabel="Inventory Item"
              endpoint="/api/inventory"
              fields={[
                { key: "item_code", label: "Item Code", type: "text", required: true },
                { key: "name", label: "Name", type: "text", required: true },
                { key: "quantity", label: "Quantity", type: "number" },
              ]}
              onSuccess={() => router.refresh()}
            />
          ) : null
        }
      />
      <table>
        {/* render filtered rows */}
      </table>
    </div>
  );
}
```

---

## Step 5 — Add TypeScript Types

Already done in Step 1.4. Make sure the type mirrors the **exact SELECT column list** in `page.tsx`. Mismatches cause runtime shape errors that are hard to debug.

---

## Step 6 — Wire Up Navigation

Add an entry to the `NAV` array in `components/Sidebar.tsx`:

```ts
{ label: "Inventory", href: "/inventory", icon: Package }
```

For a module with sub-pages:
```ts
{
  label: "Inventory",
  href: "/inventory",
  icon: Package,
  children: [
    { label: "Items", href: "/inventory/items" },
    { label: "Warehouses", href: "/inventory/warehouses" },
  ],
}
```

---

## Step 7 — Verify

```bash
# 1. No TypeScript errors
npm run build

# 2. No lint errors
npm run lint

# 3. Manual browser testing
npm run dev
```

Test the following scenarios in the browser:

| Scenario | Expected result |
|----------|----------------|
| Visit page as `developer` | Page loads, editor controls visible |
| Visit page as a viewer role | Page loads, no add/edit buttons |
| Visit page as a role without access | Redirect to `/auth/unauthorized` |
| Create a single record | New row appears after `router.refresh()` |
| Bulk import valid CSV | `inserted` count shown, rows appear |
| Bulk import with duplicates | `skipped` count shown, no crash |
| Create with missing required field | API returns 400, error shown in dialog |

---

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Forgot `router.refresh()` | New record created but doesn't appear in table | Add `router.refresh()` to `onSuccess` callback |
| Importing `lib/db.ts` in a Client Component | Runtime error: `mysql2` is not available in the browser | Move all DB calls to API routes or Server Components |
| TypeScript type doesn't match SELECT columns | `undefined` fields at runtime, silent rendering bugs | Mirror `page.tsx` SELECT columns exactly in the type |
| Page slug not seeded in `page_permissions` | All non-developer roles see `/auth/unauthorized` | Add the slug to `scripts/seed-permissions.ts` and run `npm run db:seed` |
| Using `router.push()` instead of `router.refresh()` | Page navigates away or shows stale data | Use `router.refresh()` after mutations |
| Multi-table insert without a transaction | Partial data on error (e.g. vendor inserted but no `vendor_details`) | Use `pool.getConnection()` + `beginTransaction()` |
| Bulk insert blows up on first duplicate | All subsequent rows skipped | Use `ON DUPLICATE KEY UPDATE` or catch `ER_DUP_ENTRY` per-row |
| Passing `access` prop but not using it | Viewers see edit buttons that fail with 401 | Check `access === "editor"` before rendering mutation UI |

---

## Reference Files

| What | Path |
|------|------|
| Simple API route pattern | `app/api/masters/skus/route.ts` |
| Transactional multi-table route | `app/api/masters/vendors/route.ts` |
| Complex multi-action route | `app/api/masters/raw-materials/route.ts` |
| Approval handler registry (wiring) | `lib/approvals/module-handlers.ts` |
| Approval handler logic (per domain) | `lib/approvals/handlers/<domain>.ts` (e.g. `raw-materials.ts`, `bom.ts`), shared types in `lib/approvals/handlers/types.ts` |
| History/audit trail helpers | `lib/queries/history.ts`, `lib/master-routes/history-utils.ts` |
| Approval route (approve / reject) | `app/api/approvals/[id]/route.ts` |
| Status and approval status constants | `lib/constants.ts` |
| Server page pattern | `app/masters/skus/page.tsx` |
| Client component pattern | `app/masters/skus/SkusClient.tsx` |
| SQL query file | `lib/queries/vendors.ts` |
| Type definitions | `types/masters.ts` |
| Sidebar NAV array | `components/Sidebar.tsx` |
| Permission seeding | `scripts/seed-permissions.ts` |
