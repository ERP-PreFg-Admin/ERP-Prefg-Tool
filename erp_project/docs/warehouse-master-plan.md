# Warehouse Master Page

## Context

`master_warehouse` already exists and is already load-bearing — POs, supplier invoices, warehouse mail routing and per-user data scope all resolve through it. But there is **no UI for it anywhere**. Rows are inserted by hand via SQL, which means adding a warehouse requires a developer with RDS access, and nobody outside the dev team can see what warehouses exist or correct a wrong zone/location.

Every other master (SKU, Vendor, Manufacturer, RM, PM, BOM) has a page under `/masters`. This closes that gap: `/masters/warehouses`, list + create + edit, on the same approval flow the other masters use.

### The constraint that shapes the design

`master_warehouse.name` is a **de-facto foreign key with nothing enforcing it**. It is copied by value into:

| Consumer | Column | Where |
|---|---|---|
| Purchase orders | `purchase_orders.destination` (VARCHAR) | `lib/queries/purchase-orders.ts:486` — `LEFT JOIN master_warehouse wh ON wh.name = po.destination` |
| Supplier invoices | `invoice_mfg.destination` (VARCHAR) | `lib/invoice/invoice-inward.ts` |
| Warehouse mail routing | `entity_emails.entity_code` where `entity_type='warehouse'` | `lib/mail/mailer.ts:320` `resolveRecipients("warehouse", destination)` |
| Per-user data scope | resolved id → **name** once per request | `lib/scope.ts:78-82`, `entityScopeSql.warehouseNamesByIds` |
| Invoice OCR matching | fuzzy match on `name`/`location`/`zone` | `lib/invoice/invoice-mapping.ts:74` |

A rename silently orphans all of them. **Decision: `name` is immutable after create.** The Edit dialog disables it with an inline explanation; a genuinely renamed warehouse is deactivated and re-created. This is the whole reason the page is not just a generic CRUD screen.

---

## Decisions taken

- **Name immutable after create** — see above.
- **Full approval flow** (`WAREHOUSE` module code), consistent with Vendor/Manufacturer.
- **`/masters/warehouses`, unscoped** — everyone with page access sees all warehouses, matching Vendors/Manufacturers today.
- **Schema additions**: `status` enum, `UNIQUE` on `name`, `created_by` + `updated_at`.
- **No bulk CSV upload** — there are ~10 warehouses. Skipping `WAREHOUSE_BULK` avoids a second handler, a CSV field spec and a staging path. Add it if the count ever passes ~50.

---

## 1 · Migration — `prisma/add_warehouse_master_columns.sql` (new)

Follow the header convention in `prisma/add_warehouse_entity_email_type.sql` (what / why / re-runnable / applied-on date). Remember MySQL 8.0: **no `ADD COLUMN IF NOT EXISTS`**, so this file is not re-runnable — say so in the header.

```sql
-- Duplicate-name check FIRST. The UNIQUE index below silently merges two
-- warehouses' POs, invoices and mail recipients if duplicates already exist,
-- so this must return zero rows before the ALTER is run.
SELECT name, COUNT(*) c FROM master_warehouse GROUP BY name HAVING c > 1;

ALTER TABLE master_warehouse
  ADD COLUMN status ENUM('active','inactive','in_review','rejected') NOT NULL DEFAULT 'active',
  ADD COLUMN created_by INT NULL,
  ADD COLUMN updated_at DATETIME(0) NULL ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY uq_warehouse_name (name);
```

`status` carries all four values because the approval flow needs `in_review` (locked) and `rejected` (re-editable by submitter) — see the memory note that rejection moves a record to a dedicated `rejected` status, not `draft`. Existing rows default to `active`.

Run on **both** schemas, then mirror into `prisma/schema.prisma`: add the four fields to `model master_warehouse` and a new `enum master_warehouse_status`. Per the standing preference, do **not** run `prisma generate` — the client is unused at runtime.

## 2 · Types & SQL

- `types/masters.ts` — add `Warehouse` mirroring the SELECT column list exactly. Note `WarehouseOption` already exists in `app/po-tracking/po-procurement/po-types.ts` for the PO dropdowns; leave it alone.
- `lib/queries/warehouses.ts` (new) — model on `lib/queries/vendors.ts`. Needs: `selectPaginated`, `countAll`, `selectAll`, `selectById`, `selectByNameForDup`, `insert`, `update` (**no `name` in the SET list**), `setStatus`.
- `lib/queries/approvals.ts` — one entry in `entityLabelSql`:
  ```ts
  WAREHOUSE: `
    SELECT name AS code, location AS name, zone AS secondary_code, type AS secondary_name
    FROM master_warehouse WHERE id = ? LIMIT 1
  `,
  ```
- `lib/queries/purchase-orders.ts:299` `warehouseOptions` — add `WHERE status = 'active'` so a closed warehouse leaves the PO destination dropdown without orphaning historical POs. Do the same for `entityScopeSql.warehouseOptions` (`lib/queries/entity-scope.ts:47`) and the `entityEmails.warehouseOptions` used by `app/po-tracking/po-procurement/entity-emails/page.tsx:61`.

## 3 · API — `app/api/v1/masters/warehouses/route.ts` (new)

Copy the structure of `app/api/v1/masters/manufacturers/route.ts`, minus the bulk/docs/duplicate-banking actions. Goes through `withGateway` with `access: { pageSlug: "/masters/warehouses", level: "editor" }`. Zod schema in `lib/validation/warehouses.ts` (new), alongside the other twelve.

Two actions:

- **`create`** — insert with `status = 'in_review'` and `created_by`, then `insertApproval(userId, "WAREHOUSE", id, "create")` plus one `insertApprovalItem` per field with `old_value = ""`. This is what makes `isNewRecord()` in `app/approvals/approvals-types.ts:77` render it as a New-record card. Catch `ER_DUP_ENTRY` on the new UNIQUE index → 409 "A warehouse with this name already exists".
- **`update`** — the canonical CLAUDE.md approval-submission pattern: `approvalsSql.hasPending` guard → open connection → diff `location`/`zone`/`type`/`status` against `selectById` → insert approval + items → `setStatus(in_review)`. **`name` is not in the proposed object at all**, so it can never enter a diff even if a client posts it. `remarks` is required (`z.string().trim().min(1)`) like the other master edits, archived via `insertHistoryEntry` from `lib/master-routes/history-utils.ts`.

Transactions open and close in this route only — handlers never call `beginTransaction`/`commit`/`rollback`.

## 4 · Approval handler — `lib/approvals/handlers/warehouses.ts` (new)

The simplest possible `ModuleHandler` — a single flat table, no history table, no S3 docs. Closest existing reference is `rmMatHandler` in `lib/approvals/handlers/raw-materials.ts`.

```ts
export const warehouseHandler: ModuleHandler = {
  async setStatus(conn, entityId, status) {
    await conn.execute(warehousesSql.setStatus, [status, entityId])
  },
  async applyAndArchive(conn, entityId, items) {
    const fieldMap = buildFieldMap(items)
    const [rows] = await conn.execute(warehousesSql.selectById, [entityId])
    const cur = (rows as any[])[0]
    if (!cur) throw new Error(`Warehouse ${entityId} not found`)
    // name is deliberately absent — it is the join key for POs, invoices,
    // mail routing and user scope, so it is never in a diff.
    await conn.execute(warehousesSql.update, [
      fieldMap.location ?? cur.location,
      fieldMap.zone     ?? cur.zone,
      fieldMap.type     ?? cur.type,
      fieldMap.status   ?? STATUS.ACTIVE,
      entityId,
    ])
  },
}
```

Register in three places, one line each:
- `lib/approvals/module-handlers.ts` → `WAREHOUSE: warehouseHandler`
- `app/approvals/approvals-types.ts` → `MODULE_LABEL.WAREHOUSE = "Warehouse"` and a `MODULE_COLOR` entry (unused hue: `bg-sky-50 text-sky-700 border-sky-200`)
- `app/api/v1/approvals/[id]/route.ts:110` → `if (approval.module === "WAREHOUSE") revalidateTag("ref:po-options", "max")` — without this, `getPoDropdownOptions` (`lib/cached-reference-data.ts:126`, 120s TTL) means a newly approved warehouse doesn't appear in the PO destination dropdown for up to two minutes.

No new approval-card renderer needed: `FieldDiffTable` handles the flat field diff already.

## 5 · Pages — `app/masters/warehouses/`

Copy `app/masters/manufacturers/` and strip out the documents/banking parts.

- **`page.tsx`** — server component, mirrors `app/masters/manufacturers/page.tsx`: `auth()` → `resolveAccess(userId, roles, "/masters/warehouses")` → redirect on `none` → `parsePaginationParams` → `timedQuery`. No `getUserScope` call (unscoped by decision). With ~10 rows the fuzzy-search branch is unnecessary — a single `selectAll` and client-side filter is enough; skip `parsePaginationParams` and the `pagination-bar` too unless the list grows.
- **`WarehousesClient.tsx`** — reuse `MasterToolbar`, `SearchInput`, `StatusBadge`, `RecordCountHeader`, `DownloadButton`, `TableEmpty` (`components/ui/empty-state.tsx`), and `ApprovalBanners` from `components/masters/`. Columns: Name · Location · Zone · Type (CWH/MWH badge) · Status · Actions.
- **`AddWarehouseDialog.tsx`** — name, location, zone, type. All four required.
- **`EditWarehouseDialog.tsx`** — the three-state approval-aware pattern from `app/masters/manufacturers/EditMfgDialog.tsx`: normal / `in_review` locked with blue banner / `rejected` with amber banner fetched from `/api/v1/approvals/entity?module=WAREHOUSE&entity_id=Y`. **Plus the fourth thing specific to this page**: the name input is always `disabled` with the helper text *"Used as the join key by POs, invoices and mail routing — cannot be changed."*

## 6 · Wiring

- `lib/pages.ts` — `{ slug: "/masters/warehouses", label: "Warehouses", section: "Masters" }`. This one edit feeds the admin permission grid, the sidebar lock resolution and the breadcrumb label.
- `components/Sidebar.tsx:36` — add `{ label: "Warehouses", href: "/masters/warehouses" }` to the Masters `children`. Note `CHILD_CAP` at line 65 — this becomes the 8th child, so check whether it lands under the "show more" fold.
- `scripts/seed-permissions.ts` — matrix rows for `/masters/warehouses`. Without this every non-developer role gets `/auth/unauthorized`.

---

## Verification

```bash
npx tsc --noEmit          # nothing in the new/edited files
npm run lint:changed      # 0 errors (3 pre-existing warnings in _qa-explain.mjs)
npm run test:db           # after adding the test below
npm run dev
```

**One DB test** — `tests/db/warehouse-approval.test.ts`, wrapped in `withRollback()` from `tests/helpers/db.ts`, relative imports (not `@/`). It asserts the one thing worth protecting: build a diff with a `name` item in it, run `warehouseHandler.applyAndArchive`, and assert `master_warehouse.name` is **unchanged** while `location` did change. That fails loudly if someone later adds `name` to `warehousesSql.update`.

**Browser pass** (needs a login):

| Step | Expected |
|---|---|
| Visit as a viewer role | List renders, no Add/Edit buttons |
| Visit as a role with no grant | Redirect to `/auth/unauthorized` |
| Create a warehouse | Row appears as `in_review`; a "Warehouse" card appears on `/approvals` as a New record |
| Create with an existing name | 409, dialog shows "already exists" |
| Approve it | Status → `active`; it appears in the PO destination dropdown **immediately**, not after 120s |
| Edit location + zone, submit | Fields lock, blue banner, field-level diff on `/approvals` |
| Reject with a reason | Status → `rejected`, amber banner with the reason, submitter can re-edit |
| Open Edit on any row | Name input disabled with the explanation |
| Set a warehouse to `inactive` | Drops out of the PO destination dropdown; existing POs pointing at it still render their destination |

---

## Known ceilings — not fixed here

- `app/po-tracking/po-procurement/AddPODialog.tsx:123` picks its default destination with `name.toLowerCase().includes("mumbai")`, falling back to the first `MWH`. Deactivating the Mumbai warehouse silently changes PO defaults. Left alone — out of scope, but worth a `ponytail:` comment when someone next touches that file.
- A new warehouse still needs its mail recipients added separately at `/po-tracking/po-procurement/entity-emails` (`entity_type='warehouse'`, `entity_code` = the exact name). Nothing links the two screens; consider a hint on the create-success toast.
- The real fix for the whole name-as-FK problem is a stable `warehouse_code` plus migrating `purchase_orders.destination` / `invoice_mfg.destination` / `entity_emails.entity_code` to it. That is a data migration across three tables and thousands of rows — deliberately out of scope. Immutable names make it unnecessary until then.
