# API Reference

> **Related docs:** [Authentication & Permissions](./authentication-and-permissions.md) · [Masters Module](./masters-module.md) · [PO Inwarding](./po-inwarding.md) · [Admin Panel & Data Scoping](./admin-and-data-scoping.md) · [Architecture Evolution](./architecture-evolution.md)

## Versioning — everything is under `/api/v1/`

Two routes are deliberately unversioned, because something outside this repo addresses them by URL:

| Stays unversioned | Why |
|---|---|
| `/api/auth/[...nextauth]` | the redirect URI registered in Google Cloud Console |
| `/api/health` | the ALB target-group health-check path (`deploy/setup-commands.md`) |

A new major version is a **sibling directory** (`app/api/v2/...`), not a rewrite of v1 — `app/api/v2/purchase-orders/invoice/parse` already exists alongside the v1 route.

> ⚠️ **Outbound URLs are not ours to version.** `lib/nanonets/endpoints.ts` calls Nanonets' own `/api/v2/`, and a repo-wide find-replace on `"/api/"` once rewrote it to `/api/v1/v2/` — a 404 that compiled, linted and type-checked. `tests/unit/nanonets-endpoints.test.ts` pins it.

## Complete Endpoint Index

Every route in `app/api/`, generated from the tree. Sections further down carry request/response detail for the ones that need it; the rest are one-liners here on purpose.

### Masters

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/masters/skus` | SKU CRUD + bulk (`action` discriminator) |
| `GET` | `/api/v1/masters/skus/export` | CSV / XLSX |
| `POST` | `/api/v1/masters/vendors` | Vendor create / update / bulk |
| `GET` | `/api/v1/masters/vendors/export` · `/history` | Export · edit history |
| `POST` | `/api/v1/masters/manufacturers` | Manufacturer create / update / bulk |
| `GET` | `/api/v1/masters/manufacturers/export` · `/history` | Export · edit history |
| `POST` | `/api/v1/masters/raw-materials` · `/packing-materials` | RM / PM master + rates |
| `POST` | `…/{raw,packing}-materials/mrm-bulk` · `/vrm-bulk` | Bulk rate upload (mfg / vendor) |
| `GET` | `…/{raw,packing}-materials/mrm-history` · `/vrm-history` | Rate history |
| `GET` | `…/{raw,packing}-materials/export` | Export |
| `POST` `PUT` | `/api/v1/masters/material-master` | Combined RM/PM view |
| `GET` | `/api/v1/masters/material-master/export` | Export |
| `POST` | `/api/v1/masters/recipe-master` | Recipe CRUD — **module code stays `BOM`** |
| `GET` | `/api/v1/masters/recipe-master/[id]` · `/history/[id]` · `/export` | One recipe · its history · export |
| `POST` | `/api/v1/masters/warehouses` | Warehouse master + per-entity facility routing |

### Purchase Orders

| Method | Path | Purpose |
|---|---|---|
| `GET` `POST` | `/api/v1/purchase-orders` | List · create (single, impromptu, bulk CSV) |
| `PATCH` `PUT` | `/api/v1/purchase-orders/[id]` | Edit a draft |
| `POST` | `/api/v1/purchase-orders/[id]/split` | Split into children — **refuses a draft** |
| `POST` | `/api/v1/purchase-orders/[id]/receive` | Goods receipt (procurement desk) |
| `POST` | `/api/v1/purchase-orders/[id]/cancel` · `/close` | Void · manual short-close |
| `GET` | `/api/v1/purchase-orders/[id]/preview-pdf` | The PO document |
| `GET` | `/api/v1/purchase-orders/[id]/inwarding` | Everything inwarded against one PO |
| `GET` | `/api/v1/purchase-orders/export` · `/history` | Export · `history_pos` audit |
| `GET` | `/api/v1/purchase-orders/mfg-skus` · `/quote-rate` · `/open-for-receive` | Dialog lookups |
| `POST` | `/api/v1/purchase-orders/send-mail` | Notify the manufacturer (To **and** CC) |

### Invoice Inwarding

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/purchase-orders/invoice/parse` | Multipart PDF → Nanonets (50–70 s, `maxDuration = 300`) |
| `POST` | `/api/v2/purchase-orders/invoice/parse` | The v2 parser, alongside v1 — not a replacement |
| `GET` `POST` | `/api/v1/purchase-orders/invoice` | History list (filtered) · commit (NDJSON stream) |
| `GET` | `/api/v1/purchase-orders/invoice/[id]` · `/export` | One invoice + lines · filtered export |

### Approvals

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/approvals` | Pending queue |
| `POST` | `/api/v1/approvals/[id]` | Approve / reject — dispatches via `MODULE_HANDLERS` |
| `GET` | `/api/v1/approvals/entity` | Rejection info for an edit dialog |
| `GET` | `/api/v1/approvals/entity-history` | Every approval ever raised for one record |
| `GET` | `/api/v1/approvals/history` | Global approval history |

### Manufacturing

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/manufacturing/lines` · `/misc-costs` | Mfg × SKU lines · per-SKU JW/Shrink/Shipper/Wastage |
| `GET` | `/api/v1/manufacturing/[mfgId]/lines/export` | SKUs tab |
| `GET` | `/api/v1/manufacturing/[mfgId]/misc-costs/export` | Misc. Cost tab |
| `GET` | `/api/v1/manufacturing/[mfgId]/approved-rates/export` · `/history/export` | Approved Procurement Rates |
| `GET` | `/api/v1/manufacturing/[mfgId]/agreed-rates/export` | Agreed Rates |
| `GET` | `/api/v1/manufacturing/[mfgId]/final-costing/export` · `/detailed-export` | Agreed Final Costing |

### Admin, files and the rest

| Method | Path | Purpose |
|---|---|---|
| `POST` `PATCH` | `/api/v1/admin/users` | Create · update (no DELETE — deactivate instead) |
| `GET` `POST` `DELETE` | `/api/v1/admin/permissions` · `/user-permissions` | Role grants · per-user overrides (DELETE = inherit) |
| `PUT` | `/api/v1/admin/entity-scope` | Replace one `(user, entity_type)` scope set |
| `POST` | `/api/v1/entity-emails` | Mail recipients per vendor / mfg / warehouse / employee |
| `GET` | `/api/v1/files/presign` | Short-lived S3 URL for one object |
| `GET` | `/api/v1/files/preview` | Server-side parse of a bulk CSV/Excel → `{ headers, rows }` |
| `POST` | `/api/v1/upload` | Attachment upload (images, PDF, XLSX, CSV) via `buildUploadKey` |
| `GET` | `/api/v1/debug-env-check` | Reports which env vars are *set* — never their values |
| `GET` | `/api/health` | ALB health check — **unversioned** |
| — | `/api/auth/[...nextauth]` | NextAuth (Google OAuth) — **unversioned** |

---

## Design Pattern (Current Implementation)

All mutation endpoints follow this pattern:

- **Method:** POST with a JSON body containing an `action` discriminator field
- **Auth:** Every route calls `auth()` at the top and returns `401 { error: "Unauthorized" }` if no session exists
- **Error shape:** `{ error: string }` with an appropriate HTTP status code
- **Success shape:** Varies per action (documented below)

> **`withGateway()` + Zod is now the standard**, not a plan. Every route is wrapped by `lib/gateway/with-gateway.ts`, which resolves the session, enforces an `access: { pageSlug, level }` rule, validates the body/params with Zod, stamps a request context, logs the request, and writes the `activity_log` row for every non-GET. Error shape on this layer is `{ error, code, details?, requestId }`; auth/access failures return `401`/`403` automatically, schema failures `400`. Throw `ApiError(status, code, message)` for anything that should reach the user.
>
> **Entity scope is not part of `access`.** A route that addresses one record by id must additionally call `assertInScope(scope, "mfg" | "vendor" | "warehouse" | "brand", id)` — or `assertPoInScope(userId, poId)` for purchase orders, which checks all three of a PO's dimensions at once. Ids are sequential integers, so a scoped user could otherwise reach another manufacturer's record by guessing. Routes carrying a scope guard today: every `/api/v1/purchase-orders/**`, every `/api/v1/manufacturing/**`, and the vendor/manufacturer/RM/PM export and history routes. **Brand** is the fourth dimension — reads filter in SQL, writes assert through `lib/brand-guard.ts`, because `execute()` can't expand an array param into an INSERT. See [Admin Panel & Data Scoping](./admin-and-data-scoping.md).
>
> **Master edits require `remarks`.** SKU, vendor, manufacturer and material-master update schemas all carry `remarks: z.string().trim().min(1)` — the reason is archived to `history_masters_edits.remarks` and shown in the record's history dialog and on the approval card. Rate edits archive `remarks` + `changed_by` to `history_cost_ven` / `history_cost_mfg`.

---

## Masters Endpoints

### `POST /api/v1/masters/skus`

**File:** `app/api/v1/masters/skus/route.ts` · **Schema:** `lib/validation/skus.ts` (`skuActionSchema`)

| `action` | Purpose | Detailed below |
|---|---|---|
| `create` | One SKU | ✅ |
| `update` | Edit → **approval**, never a direct write | ✅ |
| `bulk` | Rows from a parsed CSV | ✅ |
| `bulk_from_s3` | Same, from a staged S3 `key` — the path an approved `SKU_BULK` takes | — |
| `variants` | Sibling SKUs of one `brand` + `base_sku_sno`, for the create dialog | — |

#### action: `"create"` — Create a single SKU

```json
// Request body
{
  "action": "create",
  "sku_code": "SKU001",
  "name": "Product Name",
  "brand": "BrandName",
  "category": "Personal Care",
  "status": "active"
}
```

| Field | Required | Type |
|-------|----------|------|
| `action` | Yes | `"create"` |
| `sku_code` | Yes | string |
| `name` | Yes | string |
| `brand` | No | string |
| `category` | No | string |
| `status` | No | `"active"` \| `"discontinued"` \| `"new_launch"` \| `"inactive"` |

```json
// Response 200
{ "id": 42 }

// Response 400 — Zod rejected the body (the gateway's shape, not a bare message)
{ "error": "Invalid request", "code": "validation_error", "details": { "fieldErrors": { "name": ["Required"] } }, "requestId": "…" }

// Response 409 — duplicate sku_code
{ "error": "SKU code already exists" }
```

#### action: `"update"` — Edit an existing SKU (**via approval**)

The canonical approval-flow implementation — `docs/adding-a-new-module.md` and CLAUDE.md both point here. It writes **nothing** to `master_skus`: it diffs the proposed values against the current row, inserts an `approvals` + `approval_items` set, and moves the SKU to `in_review`. The values land only when an approver accepts, through `MODULE_HANDLERS.SKU.applyAndArchive`.

```json
// Request body
{
  "action": "update",
  "id": 42,
  "status": "discontinued",
  "sku_type": "FG",
  "category": "Personal Care",
  "subcategory": "Face",
  "mrp": 499,
  "remarks": "Discontinued after the Q3 range review"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | number or numeric string |
| `remarks` | **Yes** | `min(1)` — the reason is archived to `history_masters_edits.remarks` and shown on the approval card |
| `name`, `brand`, `category`, `subcategory`, `sku_type`, `filling`, `filling_uom`, `mrp`, `status` | No | Every one is optional; anything omitted keeps the record's current value. The scoped edit dialog submits only a subset |

```json
// Response 200 — nothing changed, so nothing was raised
{ "ok": true }

// Response 200 — an approval is now pending
{ "ok": true, "approval_id": 118 }

// Response 409 — this record already has a pending approval
{ "error": "This SKU already has a pending approval.", "code": "…", "requestId": "…" }
```

#### action: `"bulk"` — Bulk insert from CSV

```json
// Request body
{
  "action": "bulk",
  "rows": [
    { "sku_code": "SKU001", "name": "Product A", "brand": "Brand", "category": "Care", "status": "active" }
  ]
}
```

```json
// Response 200
{ "inserted": 5, "skipped": 2 }
```

Duplicate `sku_code` values are skipped (counted in `skipped`), not errored.

---

### `POST /api/v1/masters/vendors`

**File:** `app/api/v1/masters/vendors/route.ts` · **Schema:** `lib/validation/vendors.ts` (`vendorActionSchema`)

| `action` | Purpose | Detailed below |
|---|---|---|
| `create` | One vendor. `code` is **absent on purpose** — generated server-side | ✅ |
| `update` | Edit → approval. `remarks` mandatory | ✅ |
| `bulk` | Rows from a parsed CSV | ✅ |
| `bulk_from_s3` | Same, from a staged S3 `key` (an approved `VENDOR_BULK`) | — |
| `check_duplicates` | Read-only preview: which CSV rows collide, and which match an existing vendor and will be treated as **edits** | — |
| `update_docs` | Attach/replace the four S3 document keys (GST cert, cancelled cheque, PAN, misc) without touching the record | — |


#### action: `"create"` — Create a single vendor

```json
{
  "action": "create",
  "code": "VEN001",
  "name": "Supplier Ltd",
  "type": "rm",
  "location": "Mumbai",
  "gst_number": "27AADCS0472N1Z1",
  "status": "active"
}
```

| Field | Required | Type |
|-------|----------|------|
| `code` | Yes | string (unique) |
| `name` | Yes | string |
| `type` | Yes | `"rm"` \| `"pm"` \| `"both"` |
| `location` | No | string |
| `gst_number` | No | string |
| `status` | No | string |

Process: Runs a **transaction** — INSERT into `vendors`, then INSERT into `vendor_details` using the returned `insertId`.

```json
// Response 200
{ "id": 12 }
```

#### action: `"update"` — Edit an existing vendor

```json
{
  "action": "update",
  "vendor_id": 12,
  "name": "Updated Supplier Ltd",
  "type": "both",
  "location": "Delhi",
  "gst_number": "07AADCS0472N1Z3",
  "status": "active"
}
```

| Field | Required | Type |
|-------|----------|------|
| `vendor_id` | Yes | number |
| `name` | Yes | string |
| `type` | Yes | `"rm"` \| `"pm"` \| `"both"` |
| `location` | No | string |
| `gst_number` | No | string |
| `status` | No | `"active"` \| `"inactive"` \| `"blacklisted"` \| `"discontinued"` |

Process: Transaction — UPDATE `master_vendors`, then UPDATE `vendor_details`.

```json
// Response 200
{ "ok": true }

// Response 400 — missing vendor_id or name
{ "error": "vendor_id, name, and type are required" }
```

#### action: `"bulk"` — Bulk insert vendors

```json
{ "action": "bulk", "rows": [...] }
// Response 200
{ "inserted": 3, "skipped": 1 }
```

---

### `GET /api/v1/masters/vendors/history`

**File:** `app/api/v1/masters/vendors/history/route.ts`

Full audit trail (create/edit + approve/reject resolution) for one vendor from `history_masters_edits`, newest first. Backs the "Edit History" dialog on the vendors table.

```
GET /api/v1/masters/vendors/history?vendor_id=12
```

```json
// Response 200
{ "history": [ { "id": 9, "entity_id": 12, "action": "edit", "field": "location", "old_value": "Mumbai", "new_value": "Delhi", "resolved_at": "2026-06-01T00:00:00Z" } ] }

// 400 — missing/invalid vendor_id
{ "error": "vendor_id is required" }
```

---

### `POST /api/v1/masters/manufacturers`

**File:** `app/api/v1/masters/manufacturers/route.ts` · **Schema:** `lib/validation/manufacturers.ts` (`mfgActionSchema`)

Same action set as vendors: `create`, `update`, `bulk`, `bulk_from_s3`, `check_duplicates`, `update_docs`.


#### action: `"create"`

```json
{
  "action": "create",
  "code": "MFG001",
  "name": "Manufacturing Plant A",
  "location": "Pune",
  "gst_number": "27AADCS0472N1Z1",
  "status": "active"
}
```

Process: Transaction — INSERT into `mfgs`, then INSERT into `mfg_details`.

```json
// Response 200
{ "id": 5 }
```

#### action: `"update"` — Edit an existing manufacturer

```json
{
  "action": "update",
  "mfg_id": 5,
  "name": "Updated Plant A",
  "location": "Nashik",
  "gst_number": "27AADCS0472N1Z1",
  "status": "active"
}
```

| Field | Required | Type |
|-------|----------|------|
| `mfg_id` | Yes | number |
| `name` | Yes | string |
| `location` | No | string |
| `gst_number` | No | string |
| `status` | No | `"active"` \| `"inactive"` |

Process: Transaction — UPDATE `master_mfgs`, then UPDATE `mfg_details`.

```json
// Response 200
{ "ok": true }
```

#### action: `"bulk"`

```json
{ "action": "bulk", "rows": [...] }
// Response 200
{ "inserted": 2, "skipped": 0 }
```

---

### `GET /api/v1/masters/manufacturers/history`

**File:** `app/api/v1/masters/manufacturers/history/route.ts`

Same shape as `GET /api/v1/masters/vendors/history`, keyed by `mfg_id`.

```
GET /api/v1/masters/manufacturers/history?mfg_id=5
```

```json
// Response 200
{ "history": [ { "id": 4, "entity_id": 5, "action": "edit", "field": "status", "old_value": "active", "new_value": "inactive", "resolved_at": "2026-06-01T00:00:00Z" } ] }

// 400 — missing/invalid mfg_id
{ "error": "mfg_id is required" }
```

---

### `POST /api/v1/masters/raw-materials`

**File:** `app/api/v1/masters/raw-materials/route.ts` · **Schema:** `lib/validation/raw-materials.ts` (`rmActionSchema`)

Thirteen actions. The writes are documented below; the rest are lookups the create wizard calls as you type.

| `action` | Purpose | Detailed below |
|---|---|---|
| `create` · `create-full` | Simple insert · the full wizard (RM + vendor rates + mfg approvals) | ✅ |
| `add-rates` | Add/update rates on an existing RM | ✅ |
| `bulk` · `check_duplicates` | Staged CSV · its preview-time check | ✅ |
| `bulk_from_s3` | The staged file, on approval | — |
| `check-RM` · `check-vendor` | Duplicate checks before the wizard commits | ✅ |
| `check-make-fuzzy` | Near-miss check on `make`, so "Croda" and "CRODA Inc" don't both get created | — |
| `get-makes` · `get-materials` · `get-inci-names` | Typeahead lists for the wizard | — |
| `material-impact` | What a proposed change would touch before it is made | — |


This is the most complex master route with five actions.

#### action: `"check-RM"` — Duplicate check before create wizard

```json
{ "action": "check-RM", "name": "Aloe Vera", "make": "Natural", "inci_name": "Aloe Barbadensis" }
```

```json
// Response 200
{ "exists": false }
// or
{ "exists": true }
```

#### action: `"check-vendor"` — Check if a vendor rate already exists

```json
{ "action": "check-vendor", "name": "Aloe Vera", "vendor_id": 7, "make": "Natural", "inci_name": "..." }
```

```json
// Response 200 — no existing rate
{ "exists": false }

// Response 200 — existing rate found
{
  "exists": true,
  "existing": {
    "curr_rate": 150.00,
    "moq": 100,
    "uom": "kg",
    "effective_from": "2025-01-01"
  }
}
```

#### action: `"create"` — Create a single raw material (simple)

```json
{
  "action": "create",
  "name": "Aloe Vera Extract",
  "rm_code": "RM001",
  "make": "Natural",
  "type": "botanical",
  "uom": "kg",
  "hsn_code": "330129",
  "inci_name": "Aloe Barbadensis"
}
```

```json
// Response 200
{ "id": 23 }
```

#### action: `"create-full"` — Full wizard: RM + vendor rates + manufacturer approvals

This is the primary create path. Runs in a **single transaction**.

```json
{
  "action": "create-full",
  "rm": {
    "name": "Aloe Vera Extract",
    "make": "Natural",
    "type": "botanical",
    "uom": "kg",
    "hsn_code": "330129",
    "inci_name": "Aloe Barbadensis",
    "status": "active"
  },
  "vendors": [
    {
      "vendor_id": 7,
      "vendor_code": "VEN007",
      "curr_rate": 150.00,
      "moq": 100,
      "rate_uom": "kg",
      "effective_from": "2025-01-01"
    }
  ],
  "manufacturers": [
    { "mfg_id": 2, "mfg_code": "MFG002" }
  ]
}
```

Process:
1. INSERT into `master_rm`
2. For each vendor: if a rate already exists → archive old row to `vrm_history` + `history_vrm`, then UPDATE `rm_vrm_dynamic`; otherwise INSERT new row
3. For each manufacturer: if a rate already exists → archive old row to `history_mrm`, then UPDATE `rm_mrm_fixed`; otherwise INSERT new row

```json
// Response 200
{ "id": 23 }
```

#### action: `"add-rates"` — Add or update rates on an existing RM

Used by the pencil-edit dialogs on the Raw Materials page. Looks up the RM by `name + make + inci_name`, then upserts vendor and/or manufacturer rates with full history archiving.

```json
{
  "action": "add-rates",
  "name": "Aloe Vera Extract",
  "make": "Natural",
  "inci_name": "Aloe Barbadensis",
  "vendors": [
    {
      "vendor_id": 7,
      "vendor_code": "VEN007",
      "curr_rate": 160.00,
      "moq": 100,
      "rate_uom": "kg",
      "rate_status": "active",
      "effective_from": "2025-06-01",
      "effective_to": null
    }
  ],
  "manufacturers": [
    {
      "mfg_id": 2,
      "mfg_code": "MFG002",
      "curr_rate": 155.00,
      "rate_uom": "kg",
      "effective_from": "2025-06-01"
    }
  ]
}
```

At least one of `vendors` or `manufacturers` must be non-empty. Each entry is upserted (archive-then-update if exists, insert if new).

```json
// Response 200
{ "id": 23 }

// Response 404 — RM not found by name+make+inci_name
{ "error": "Material not found" }
```

#### action: `"bulk"` — Bulk insert raw materials

```json
{ "action": "bulk", "rows": [...] }
// Response 200
{ "inserted": 10, "skipped": 2 }
```

---

### `GET /api/v1/masters/raw-materials/mrm-history` · `GET /api/v1/masters/raw-materials/vrm-history`

**Files:** `app/api/v1/masters/raw-materials/mrm-history/route.ts`, `.../vrm-history/route.ts`

Full rate-change history for one RM×Manufacturer (`history_mrm`) or RM×Vendor (`history_vrm`) pair, newest first. Backs the "Rate History" dialog on the RM Rate Master.

```
GET /api/v1/masters/raw-materials/mrm-history?rm_id=1&mfg_id=2
GET /api/v1/masters/raw-materials/vrm-history?rm_id=1&vendor_id=2
```

```json
// Response 200
{ "history": [ { "id": 1, "rm_id": 1, "mfg_id": 2, "curr_rate": 150.00, "changed_at": "2026-06-01T00:00:00Z" } ] }

// 400 — missing/invalid ids
{ "error": "rm_id and mfg_id are required" }
```

---

### `POST /api/v1/masters/raw-materials/mrm-bulk` · `POST /api/v1/masters/raw-materials/vrm-bulk`

**Files:** `app/api/v1/masters/raw-materials/mrm-bulk/route.ts`, `.../vrm-bulk/route.ts`

Bulk CSV upload for RM × Manufacturer rates (`mrm-bulk`, module `RM_RATE_BULK`) and RM × Vendor rates (`vrm-bulk`, module `RM_VRM_BULK`). Separate endpoints from `POST /api/v1/masters/raw-materials` so `CsvImportDialog`'s fixed `"bulk"` / `"check_duplicates"` action names don't collide with that route's own (unrelated) base-material bulk upload.

#### action: `"check_duplicates"` — CSV preview-time validation

```json
// mrm-bulk
{ "action": "check_duplicates", "rows": [ { "rm_code": "RM001", "mfg_code": "MFG001", "approved_vendor_code": "VEN001" } ] }
// vrm-bulk
{ "action": "check_duplicates", "rows": [ { "rm_code": "RM001", "vendor_code": "VEN001", "mfg_code": "MFG001" } ] }
```

Resolves each row's `rm_code` (must exist and be `active`), `mfg_code`/`vendor_code` against the DB, and flags duplicate RM+Manufacturer / RM+Vendor pairs repeated within the file.

```json
// Response 200
{ "duplicates": { "0": ["RM code \"RM001\" is not active"] } }
```

#### action: `"bulk"` — Stage the whole file as one pending approval

```json
{ "action": "bulk", "rows": [...] }
```

Process: uploads rows as CSV to S3 (`imports/rm-mrm-bulk/YYYY-MM/...` or `imports/rm-vrm-bulk/YYYY-MM/...`) and stages ONE approval (`RM_RATE_BULK` or `RM_VRM_BULK`). Nothing is written to `rm_mrm`/`rm_vrm` here — the insert happens in the matching module handler's `applyAndArchive` once approved.

```json
// Response 200
{ "ok": true, "approval_id": 44, "staged": 12, "skipped": 0 }
```

---

### `POST /api/v1/masters/packing-materials`

**File:** `app/api/v1/masters/packing-materials/route.ts` · **Schema:** `lib/validation/packing-materials.ts` (`pmActionSchema`)

Ten actions, mirroring RM without the INCI-specific ones: `create`, `create-full`, `add-rates`, `bulk`, `bulk_from_s3`, `check_duplicates`, `check-PM`, `check-vendor`, `get-materials`, `material-impact`.


#### action: `"check-PM"` — Duplicate check before wizard

```json
{ "action": "check-PM", "name": "200ml Bottle", "type": "Primary" }
```

```json
// Response 200
{ "exists": false }
// or
{ "exists": true }
```

#### action: `"check-vendor"` — Check if a vendor rate already exists

```json
{ "action": "check-vendor", "name": "200ml Bottle", "type": "Primary", "vendor_id": 5 }
```

```json
// Response 200 — no existing rate
{ "exists": false }

// Response 200 — existing rate found
{
  "exists": true,
  "existing": { "curr_rate": 3.50, "moq": 500, "uom": "pcs" }
}
```

#### action: `"create"` — Simple insert (no rate rows)

```json
{
  "action": "create",
  "name": "200ml Bottle",
  "pm_code": "PM001",
  "type": "Primary",
  "hsn_code": "392390",
  "uom": "pcs",
  "status": "active"
}
```

```json
// Response 200
{ "id": 8 }
```

#### action: `"create-full"` — Full wizard: PM + vendor rates + manufacturer approvals

Runs in a **single transaction**.

Process:
1. INSERT into `master_pm`
2. For each vendor: if a rate already exists → archive old row to `history_vrm` (via `archiveVendorRate`), then UPDATE `pm_vrm_dynamic`; otherwise INSERT new row
3. For each manufacturer: if a rate already exists → archive old row to `history_mrm`, then UPDATE `pm_mrm_fixed`; otherwise INSERT new row

```json
{
  "action": "create-full",
  "pm": {
    "name": "200ml Bottle",
    "type": "Primary",
    "hsn_code": "392390",
    "uom": "pcs",
    "status": "active"
  },
  "vendors": [
    { "vendor_id": 5, "vendor_code": "VEN005", "curr_rate": 3.50, "moq": 500, "rate_uom": "pcs" }
  ],
  "manufacturers": [
    { "mfg_id": 2, "mfg_code": "MFG002" }
  ]
}
```

```json
// Response 200
{ "id": 8 }
```

#### action: `"add-rates"` — Add or update rates on an existing PM

Used by the pencil-edit dialogs on the Packing Materials page. Pass `pm_id` directly to bypass the name+type lookup (recommended for edit flows where `type` may be null). At least one of `vendors` or `manufacturers` must be non-empty.

```json
{
  "action": "add-rates",
  "pm_id": 8,
  "vendors": [
    {
      "vendor_id": 5,
      "vendor_code": "VEN005",
      "curr_rate": 3.75,
      "moq": 500,
      "rate_uom": "pcs",
      "rate_status": "active",
      "effective_from": "2025-06-01",
      "effective_to": null
    }
  ],
  "manufacturers": [
    {
      "mfg_id": 2,
      "mfg_code": "MFG002",
      "curr_rate": 3.60,
      "rate_uom": "pcs",
      "effective_from": "2025-06-01"
    }
  ]
}
```

If `pm_id` is omitted, falls back to looking up the PM by `name + type` (same as the wizard flow).

```json
// Response 200
{ "pmId": 8 }

// Response 404 — PM not found (only when pm_id is omitted and name lookup fails)
{ "error": "Material not found" }
```

#### action: `"bulk"`

```json
{ "action": "bulk", "rows": [...] }
// Response 200
{ "inserted": 5, "skipped": 0 }
```

---

### `GET /api/v1/masters/packing-materials/mrm-history` · `GET /api/v1/masters/packing-materials/vrm-history`

**Files:** `app/api/v1/masters/packing-materials/mrm-history/route.ts`, `.../vrm-history/route.ts`

Same shape as the RM history endpoints above, keyed by `pm_id` instead of `rm_id`.

```
GET /api/v1/masters/packing-materials/mrm-history?pm_id=1&mfg_id=2
GET /api/v1/masters/packing-materials/vrm-history?pm_id=1&vendor_id=2
```

```json
// Response 200
{ "history": [ { "id": 1, "pm_id": 1, "vendor_id": 2, "curr_rate": 3.50, "changed_at": "2026-06-01T00:00:00Z" } ] }

// 400 — missing/invalid ids
{ "error": "pm_id and vendor_id are required" }
```

---

### `POST /api/v1/masters/packing-materials/mrm-bulk` · `POST /api/v1/masters/packing-materials/vrm-bulk`

**Files:** `app/api/v1/masters/packing-materials/mrm-bulk/route.ts`, `.../vrm-bulk/route.ts`

Same `"check_duplicates"` / `"bulk"` action pair and staged-approval behaviour as the RM bulk rate endpoints above (modules `PM_RATE_BULK` / `PM_VRM_BULK`), keyed by `pm_code` instead of `rm_code`. `mrm-bulk` does not check an `approved_vendor_code` column (PM manufacturer rates have no vendor-approval field).

```json
// mrm-bulk
{ "action": "check_duplicates", "rows": [ { "pm_code": "PM001", "mfg_code": "MFG001" } ] }
// vrm-bulk
{ "action": "check_duplicates", "rows": [ { "pm_code": "PM001", "vendor_code": "VEN001" } ] }
```

```json
// Response 200 (bulk)
{ "ok": true, "approval_id": 45, "staged": 8, "skipped": 0 }
```

---

### `POST /api/v1/masters/material-master`

**File:** `app/api/v1/masters/material-master/route.ts` · **Schema:** `lib/validation/material-master.ts`

**Two methods, and the discriminator is `material`, not `action`:**

| Method | Body | Purpose |
|---|---|---|
| `POST` | `{ action: "create", material: "rm" \| "pm", … }` | Insert a base record |
| `PUT` | `{ material: "rm" \| "pm", id, …, remarks }` | Edit → approval. **`remarks` is mandatory**; there is no `action` field on the update body |

`rm` requires `name` + `inci_name`; `pm` requires `name` and accepts `pantone_color`. Everything else (`make`, `type`, `uom`, `hsn_code`, `status`) is optional and nullable — bulk sheets routinely leave them blank.


Unified endpoint for the Material Master page. Inserts a base material record only — no vendor or manufacturer rate rows. The `material` field determines which table is written to.

#### action: `"create"` — Insert a Raw Material base record

```json
{
  "action": "create",
  "material": "rm",
  "name": "Aloe Vera Extract",
  "make": "Natural",
  "inci_name": "Aloe Barbadensis",
  "type": "Botanical",
  "uom": "kg",
  "hsn_code": "330129",
  "status": "active"
}
```

| Field | Required | Notes |
|---|---|---|
| `material` | Yes | `"rm"` |
| `name` | Yes | |
| `make` | Yes | Used in duplicate detection |
| `inci_name` | Yes | Used in duplicate detection |
| `type`, `uom`, `hsn_code`, `status` | No | |

```json
// Response 200
{ "id": 23 }

// Response 409 — duplicate check failed
{ "error": "A raw material with this code already exists." }
```

#### action: `"create"` — Insert a Packing Material base record

```json
{
  "action": "create",
  "material": "pm",
  "name": "200ml Bottle",
  "type": "Primary",
  "uom": "pcs",
  "hsn_code": "392390",
  "status": "active"
}
```

| Field | Required | Notes |
|---|---|---|
| `material` | Yes | `"pm"` |
| `name` | Yes | |
| `type` | Yes | Used in duplicate detection |
| `uom`, `hsn_code`, `status` | No | |

```json
// Response 200
{ "id": 8 }
```

---

### `POST /api/v1/masters/recipe-master`

**File:** `app/api/v1/masters/recipe-master/route.ts` · **Schema:** `lib/validation/recipe.ts`

Actions: `check-existing`, `create-full`, `update-status`, `check_duplicates`, `bulk`. **The approval module code is `BOM`, not `RECIPE`** — `approvals.module` still stores `'BOM'`/`'BOM_BULK'` for every existing row, so the handler, label and colour maps are all keyed on it. Only the user-facing label became "Recipe".


> Rewritten (commit `449b4a0`) to go through the approval flow and support bulk CSV upload. The old `action: "create"` / `"bulk"` pair (direct insert, no approval, and a `mfg_id`/`sku_code` shape that didn't match the real `master_bom`/`details_bom` schema) no longer exists. Uses `withGateway` — see the note in [Design Pattern](#design-pattern-current-implementation).

Backs the BOM creation wizard (`BomCreationWizard.tsx`). Five actions:

#### action: `"check-existing"` — Dry-run duplicate check (Step 1)

```json
{ "action": "check-existing", "sku_id": 12 }
```

```json
// Response 200
{ "hasActive": true, "bom_id": 31, "bom_code": "BOM001", "bom_count": 2 }
```

#### action: `"create-full"` — Single atomic submit (manual entry or CSV step)

Handles both `"new-version"` and `"update-existing"` modes. Runs in a **transaction**: inserts/locks the `master_bom` header (status → `in_review`) and raises one `BOM` approval encoding the full RM/PM line diff plus any staged artifact add/remove as `approval_items`. `details_bom` and `bom_artifacts` are only written when the approval is approved (see `bomHandler.applyAndArchive` in `lib/approvals/module-handlers.ts`).

```json
{
  "action": "create-full",
  "mode": "new-version",
  "sku_id": 12,
  "bom_code": "BOM002",
  "effective_from": "2025-01-01",
  "rm_lines": [ { "mtrl_type": "rm", "mtrl_id": 23, "amount": 5.0, "uom": "kg" } ],
  "pm_lines": [ { "mtrl_type": "pm", "mtrl_id": 8, "amount": 1, "uom": "pcs" } ],
  "artifact_adds": [],
  "artifact_removes": [],
  "source": "manual"
}
```

For `"update-existing"`, pass `bom_id` instead of `bom_code`/`effective_from`; the diff is computed against the BOM's current lines instead of "nothing".

```json
// Response 200
{ "ok": true, "bom_id": 31, "approval_id": 57 }

// 400 — sku_id mismatch on update-existing
{ "error": "This BOM does not belong to the selected SKU." }

// 409 — another approval already pending on this BOM
{ "error": "This BOM already has a pending approval." }
```

#### action: `"update-status"` — Direct status change (no approval gate)

Used by the Edit BOM dialog. Blocked only while an approval is already pending for this BOM. Setting `status: "active"` also discontinues any other active BOM for the same SKU (same invariant `bomHandler.applyAndArchive` enforces on approval).

```json
{ "action": "update-status", "bom_id": 31, "status": "active" }
```

```json
// Response 200
{ "ok": true }

// 409 — pending approval blocks a direct status change
{ "error": "This BOM has a pending approval — resolve it before changing status directly." }
```

#### action: `"check_duplicates"` — CSV preview-time validation

Reused by `CsvImportDialog` before the bulk submit is allowed. Re-runs the same checks `BOM_BULK`'s `applyAndArchive` performs at approval time: SKU exists & active, RM/PM material codes resolve & active, per-SKU RM total is within `RM_TOTAL_MIN`–`RM_TOTAL_MAX`%, no duplicate material line within a SKU group, and no inconsistent `bom_code`/`effective_from` within a SKU group. `CsvImportDialog` is wired with `requireAllValid` for BOM, so any flagged row blocks the whole upload.

```json
{ "action": "check_duplicates", "rows": [ { "sku_code": "SKU001", "mtrl_type": "rm", "mtrl_code": "RM001", "amount": 5, "bom_code": "BOM001", "effective_from": "2025-01-01" } ] }
```

```json
// Response 200
{ "duplicates": { "0": ["SKU \"SKU001\" is not active"] } }
```

#### action: `"bulk"` — Stage the whole CSV as one pending approval

```json
{ "action": "bulk", "rows": [...] }
```

Process: uploads the rows as a CSV to S3 (`imports/bom-bulk/YYYY-MM/...`) and stages ONE `BOM_BULK` approval referencing that file. Nothing is inserted into `master_bom`/`details_bom` here — the real per-SKU grouping, validation, and insert happens in `BOM_BULK`'s `applyAndArchive` once an admin approves.

```json
// Response 200
{ "ok": true, "approval_id": 61, "staged": 40, "skipped": 0 }
```

---

### `POST /api/v1/masters/warehouses`

**File:** `app/api/v1/masters/warehouses/route.ts` · **Schema:** `lib/validation/warehouses.ts` (`warehouseActionSchema`)

Writes `master_warehouse` + `details_warehouse_entity`. Both actions go through the **approval flow** — neither writes the record directly.

| `action` | Body | Effect |
|---|---|---|
| `create` | `{ name, location, zone, type, state?, entities? }` | Inserts the location `in_review` plus its per-entity rows, then raises one `WAREHOUSE` approval with an item per field (`old_value` `""`, so the queue renders it as a New-record card). `200 { ok, approval_id }` · `409` duplicate name |
| `update` | `{ id, location, zone, type, state?, status?, entities?, remarks }` | The canonical pattern: `hasPending` guard → diff → approval + items → `in_review`. `200 { ok, approval_id }` · `409` already pending · `404` |

> **`name` is deliberately absent from `update`.** `purchase_orders.destination`, `invoice_mfg.destination` and `entity_emails.entity_code` are all unenforced `VARCHAR` copies of it with no foreign key anywhere, so a rename orphans three tables silently. Leaving it out of the schema means it cannot enter a diff even if a client posts it.

`entities[]` is one row per legal entity at that site — `entity_code` plus the Unicommerce `facility_code`, an optional `type` override, and the bill-to / ship-to registrations. **GST is state-wise**, which is why the bill-to lives per (site, entity) rather than per entity. `ship_to_pincode` is validated as exactly 6 digits because the column is `CHAR(6)` and pads a short value rather than rejecting it.

---

## Purchase Orders

All PO routes are under `app/api/v1/purchase-orders/`.

---

### `GET /api/v1/purchase-orders`

**File:** `app/api/v1/purchase-orders/route.ts`

Returns all purchase orders joined with manufacturer name, SKU name, and email.

```json
// Response 200 — array of PoRow objects
[
  {
    "id": 1, "po_no": "PO-2026-001", "po_type": "normal",
    "status": "raised", "email_sent_at": "2026-06-15T09:23:00Z",
    "mfg_id": 3, "mfg_code": "MFG003", "mfg_name": "Plant A", "mfg_email": "plant@example.com",
    "sku_code": "SKU001", "sku_name": "Face Wash", "qty": 500,
    "expected_on": "2026-07-01", "attachment_key": null
  }
]
```

---

### `POST /api/v1/purchase-orders`

**File:** `app/api/v1/purchase-orders/route.ts`

Handles three modes via the body's `action` or `po_type` field.

#### Mode 1 — Normal PO (direct raise, no approval)

```json
// Request body
{
  "po_type": "normal",
  "mfg_id": 3,
  "sku_code": "SKU001",
  "qty": 500,
  "expected_on": "2026-07-01",
  "destination": "Warehouse A"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `po_type` | Yes | `"normal"` |
| `mfg_id` | Yes | number |
| `sku_code` | Yes | must be `active` |
| `qty` | Yes | > 0 |
| `expected_on` | No | date string |
| `destination` | No | string |

Process: inserts directly as `raised`; no approval record created. PO number format: `PO-YYYY-NNN`.

```json
// Response 200
{ "ok": true, "po_no": "PO-2026-001" }
```

#### Mode 2 — Impromptu PO (draft → approval → raised)

```json
{
  "po_type": "impromptu",
  "mfg_id": 3,
  "sku_code": "SKU001",
  "qty": 200,
  "expected_on": "2026-07-15",
  "destination": "Warehouse B",
  "reason": "Urgent restock"
}
```

Process: inserts PO as `draft`, creates an `approvals` record with `approval_items` showing the full diff. On approval the PO status moves to `raised` and an email with the PDF is auto-sent. PO number format: `IMP-YYYY-NNN`.

```json
// Response 200
{ "ok": true, "approval_id": 42, "po_no": "IMP-2026-007" }
```

#### Mode 3 — Bulk CSV upload (approval gated)

```json
{
  "action": "bulk_csv",
  "key": "imports/purchase-orders/2026-06/bulk_1718000000.csv",
  "filename": "june_orders.csv"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `action` | Yes | `"bulk_csv"` |
| `key` | Yes | S3 object key returned by `POST /api/v1/upload` |
| `filename` | Yes | Original filename (shown in the approval diff) |

Process: saves the S3 key + filename as `approval_items` under module `PO_BULK`. When an approver approves the record, the server fetches the file, parses each row, and inserts POs directly as `raised`. No individual PO approval records are created.

```json
// Response 200
{ "ok": true, "approval_id": 55 }
```

**Common error responses:**

```json
// 400 — missing / invalid field
{ "error": "Manufacturer is required." }
{ "error": "SKU not found." }
{ "error": "SKU is not active." }

// 409 — duplicate PO number (rare race condition)
{ "error": "PO number already exists, please retry." }
```

---

### `PATCH /api/v1/purchase-orders/[id]`

**File:** `app/api/v1/purchase-orders/[id]/route.ts`

Update the S3 attachment key on a PO. If a previous key exists it is deleted from S3 before the new one is saved.

```json
// Request body
{ "attachment_key": "attachments/purchase-orders/1/attachment.pdf" }
// or null to remove the attachment
{ "attachment_key": null }
```

```json
// Response 200
{ "ok": true }
```

---

### `POST /api/v1/purchase-orders/[id]/split`

**File:** `app/api/v1/purchase-orders/[id]/split/route.ts`

> Reworked (commit `3ae9bc5`). Now uses `withGateway` (see [Design Pattern](#design-pattern-current-implementation)); only 1 split row is required (previously 2), the parent's `qty`/`total_amount` is now reduced by the split total instead of `received_qty` being credited, and the response no longer includes `split_type`.

Split a PO into N child POs, each optionally destined for a different manufacturer and warehouse. Splittable statuses: `raised`, `punched`, `partially_received`.

**A draft cannot be split.** A split divides an order the manufacturer already has; before the mail goes out there is nothing to divide — change the quantity instead. "Draft" here means what PO Tracking shows (`isDraftPo` in `lib/po/po-rules.ts`): a stored `draft`, **or** a `raised` PO with no `email_sent_at`. The table hides the Split button on exactly that set, and this route refuses the same set with a 409 — a looser API would let a draft be split by URL.

```json
// Request body
{
  "splits": [
    { "mfg_id": 3, "destination": "Warehouse A", "qty": 200 },
    { "mfg_id": 5, "destination": "Warehouse B", "qty": 150 }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `splits` | Yes | array, min 1 entry |
| `splits[].mfg_id` | Yes | manufacturer for this child PO |
| `splits[].qty` | Yes | > 0 |
| `splits[].destination` | No | warehouse name |

**Parent PO effect** — the parent's `qty` (and `total_amount`, recalculated from `unit_price`) is reduced by the split total; `status` and `received_qty` are left untouched — a split is not a receiving event. `short_closed` is now set only manually (e.g. via a separate Close action), never automatically by splitting.

Children are always `raised`. (The `draft` parent → `draft` children branch, and the per-child `PO` approval it minted, is now unreachable and kept only as a description of what relaxing the rule would have to do.) Child PO numbers: `{parent_po_no}-S001`, `{parent_po_no}-S002`, … If the parent was `draft`, each child additionally gets its own `PO` approval record (create) with a full field diff. Splitting a parent that isn't `draft` inserts the children directly, same as a normal raise.

```json
// Response 200
{ "ok": true, "splits_created": 2 }

// 400 — validation / over-limit
{ "error": "Each split row must have a manufacturer selected." }
{ "error": "Split total (350) exceeds remaining qty (300)." }

// 404
{ "error": "PO not found." }

// 409 — PO status prevents splitting
{ "error": "Cannot split a PO with status 'received'. Allowed: raised, punched, partially_received." }
// 409 — still a draft
{ "error": "PEP-2608-004 is still a draft. Send it to the manufacturer first — a split divides an order they already have." }
```

---

### `POST /api/v1/purchase-orders/[id]/receive`

**File:** `app/api/v1/purchase-orders/[id]/receive/route.ts` (new)

Record a manual goods receipt against a PO. Credits `qty` to `received_qty` and auto-marks the PO `received` once the remainder falls within tolerance (`min(100, 10% of qty)` — same rule the old Split flow used). Receivable statuses: `raised`, `punched`, `partially_received`. Row-locks the PO for the duration of the transaction so two concurrent receipts on the same PO serialize instead of racing on a stale `received_qty`.

```json
// Request body
{ "qty": 150 }
```

```json
// Response 200
{ "ok": true, "received_qty": 350, "status": "partially_received" }
// status is "received" once the remainder is within tolerance

// 400 — over-limit
{ "error": "Received qty (500) exceeds remaining qty (300)." }

// 404
{ "error": "PO id=42 not found" }

// 409 — PO status prevents receiving
{ "error": "Cannot receive against a PO with status 'draft'. Allowed: raised, punched, partially_received." }
```

---

### `GET /api/v1/purchase-orders/[id]/preview-pdf`

Streams the generated PO PDF inline so the user can review it in a new browser tab before sending the email. No DB changes.

```
GET /api/v1/purchase-orders/42/preview-pdf
```

**Response:** `Content-Type: application/pdf` byte stream.

---

### `POST /api/v1/purchase-orders/[id]/cancel`

**File:** `app/api/v1/purchase-orders/[id]/cancel/route.ts`

> Changed: now uses `withGateway`, accepts an optional `reason`, and **no longer sends an email**. Notifying the manufacturer is a separate, explicit step — select the (now-cancelled) PO in the PO Procurement table's checkbox selection and use "Review & Send Mail" (`POST /api/v1/purchase-orders/send-mail`).

Fully cancel a PO — distinct from Short Close, which accepts partial fulfillment as final. Cancellable statuses: `raised`, `punched`, `partially_received`.

```json
// Request body
{ "reason": "Vendor unable to fulfil" }
// reason is optional, max 1000 characters
```

```json
// Response 200
{ "ok": true }

// 404
{ "error": "PO id=42 not found" }

// 409 — PO status prevents cancelling
{ "error": "Cannot cancel a PO with status 'draft'. Allowed: raised, punched, partially_received." }
```

---

### `POST /api/v1/purchase-orders/send-mail`

**File:** `app/api/v1/purchase-orders/send-mail/route.ts` (new — replaces the removed `POST /api/v1/purchase-orders/[id]/send-email`)

Consolidated notification send from the PO Procurement table's checkbox selection: pick any set of POs (any status, any manufacturer), group them by manufacturer, and send **one email per manufacturer** (`sendMfgSelectionEmail` in `lib/mail/mailer.ts`) listing all the selected POs for that manufacturer. Not gated by approval and does not mutate any PO's status — it only notifies; status changes (raise/split/cancel) already happened through their own flows before this step.

```json
// Request body
{ "po_ids": [12, 13, 14] }
```

```json
// Response 200 — per-manufacturer send report
{
  "ok": true,
  "results": [
    { "mfg_id": 3, "mfg_name": "Plant A", "sent": true },
    { "mfg_id": 5, "mfg_name": "Plant B", "sent": false, "error": "SMTP timeout" }
  ]
}
```

Note: the endpoint always returns `200` with `ok: true` — check each entry's `sent` flag for per-manufacturer failures.

---

### `GET /api/v1/purchase-orders/export`

**File:** `app/api/v1/purchase-orders/export/route.ts` (new)

Exports every PO matching the PO Procurement page's current filters/search/sort as CSV or Excel — same `WHERE` clause and columns as `PoTable.tsx`, just unpaginated.

```
GET /api/v1/purchase-orders/export?format=csv&status=raised&mfgCode=MFG003&sortBy=date&sortDir=desc
```

| Query param | Required | Notes |
|-------------|----------|-------|
| `format` | No | `"csv"` (default) \| `"xlsx"` |
| `search` | No | matches PO No. / Mfg code / Mfg name / SKU code / SKU name |
| `status` | No | PO status tab |
| `mfgCode` | No | exact manufacturer code |
| `poType` | No | `"normal"` \| `"impromptu"` |
| `dateFrom`, `dateTo` | No | PO date range |
| `sku` | No | exact SKU code |
| `destination` | No | exact destination/warehouse name |
| `sortBy` | No | column key, default `"date"` |
| `sortDir` | No | `"asc"` \| `"desc"`, default `"desc"` |

**Response:** `200` — file attachment (`Content-Disposition: attachment`). `413` if the filtered result exceeds 50,000 rows — narrow the filters and retry.

```json
// 413 — result set too large
{ "error": "Export limited to 50,000 rows. Query returned 62,481. Apply filters to narrow the result." }
```

---

### `GET /api/v1/purchase-orders/history`

**File:** `app/api/v1/purchase-orders/history/route.ts` (new)

Returns the `history_pos` audit trail for one PO — every create/update the PO bulk CSV flow recorded against it — newest first. Shown from `PoTable`'s Actions menu via `PoHistoryDialog.tsx`.

```
GET /api/v1/purchase-orders/history?po_id=42
```

```json
// Response 200
{ "history": [ { "id": 1, "po_id": 42, "action": "update", "field": "received_qty", "old_value": "0", "new_value": "150", "changed_at": "2026-06-01T00:00:00Z" } ] }

// 400 — missing/invalid po_id
{ "error": "po_id is required" }
```

---

### `GET /api/v1/purchase-orders/mfg-skus`

**File:** `app/api/v1/purchase-orders/mfg-skus/route.ts` (new)

Active SKUs one manufacturer currently produces — populates the "Add PO" dialog's SKU rows once a manufacturer is picked (`AddPODialog.tsx`).

```
GET /api/v1/purchase-orders/mfg-skus?mfg_id=3
```

```json
// Response 200
{ "skus": [ { "sku_code": "SKU001", "sku_name": "Face Wash" } ] }
```

---

## Manufacturing Endpoints

### `POST /api/v1/manufacturing/misc-costs`

**File:** `app/api/v1/manufacturing/misc-costs/route.ts`

Create, update, or bulk-import a `bom_misc` line — a manufacturer's per-SKU Job Work / Shrink Wrap / Shipper / Wastage cost. No approval flow.

#### action: `"create-misc"`

```json
{
  "action": "create-misc",
  "bom_id": 31,
  "mfg_id": 3,
  "type": "job_work",
  "cost": 12.5,
  "effective_from": "2026-01-01",
  "effective_till": null,
  "status": "active"
}
```

```json
// Response 200
{ "ok": true, "id": 9 }
```

#### action: `"update-misc"`

```json
{ "action": "update-misc", "id": 9, "cost": 13.0, "effective_from": "2026-01-01", "effective_till": null, "status": "active" }
```

```json
// Response 200
{ "ok": true }

// 404
{ "error": "Cost line not found." }
```

#### action: `"bulk"` — CSV import, scoped to one manufacturer

Requires a `mfg_id` query param — every `bom_misc` row belongs to one manufacturer, which the page already knows, so it's passed once instead of per row.

```
POST /api/v1/manufacturing/misc-costs?mfg_id=3
```
```json
{ "action": "bulk", "rows": [ { "sku_code": "SKU001", "type": "job_work", "cost": "12.5", "effective_from": "2026-01-01", "effective_till": "", "status": "active" } ] }
```

Each row is resolved to a `bom_misc` line via `sku_code` + `mfg_id`; rows with a missing/invalid field, an unrecognised `type`, or a `sku_code` not linked to this manufacturer are skipped (with a reason) rather than failing the whole batch.

```json
// Response 200
{ "ok": true, "inserted": 8, "skipped": 1 }

// 400 — missing mfg_id query param
{ "error": "Missing or invalid mfg_id query param" }
```

---

### Cost-master export endpoints

**Files:** `app/api/v1/manufacturing/[mfgId]/agreed-rates/export/route.ts`, `.../approved-rates/export/route.ts`, `.../approved-rates/history/export/route.ts`, `.../misc-costs/export/route.ts`, `.../final-costing/export/route.ts`, `.../final-costing/detailed-export/route.ts`, `.../lines/export/route.ts`

Export the manufacturer cost-master tabs (Agreed Rates, Approved Procurement Rates, Approved Rates history, Misc. Costs, Agreed Final Costing, manufacturing lines) as CSV or Excel — same rows/queries as the corresponding client component, so the export always matches what's on screen.

```
GET /api/v1/manufacturing/3/agreed-rates/export?mode=rm&format=csv
GET /api/v1/manufacturing/3/approved-rates/export?mode=pm&format=xlsx
GET /api/v1/manufacturing/3/approved-rates/history/export?mode=rm&format=csv
GET /api/v1/manufacturing/3/misc-costs/export?format=xlsx
GET /api/v1/manufacturing/3/final-costing/export?format=csv
GET /api/v1/manufacturing/3/final-costing/detailed-export?format=xlsx
GET /api/v1/manufacturing/3/lines/export?format=csv
```

| Query param | Required | Notes |
|-------------|----------|-------|
| `mode` | No | `"rm"` (default) \| `"pm"` — not applicable to `misc-costs/export` (all 4 cost types are exported together, distinguished by a `Type` column) |
| `format` | No | `"csv"` (default) \| `"xlsx"` |

`lines/export` **lost its status segment**: it was `lines/[status]/export`, and now exports every manufacturing line for the manufacturer as one merged list (matching `ManufacturingLinesClient`, which merged its status tabs into a single list).

`final-costing/detailed-export` is the **"Detailed Breakup (Negotiation)"** export: a two-sheet workbook showing where the agreed MRM rate sits relative to the cheapest / most expensive vendor rate currently on offer for each RM/PM component, at both SKU-total and per-material line level. `format=csv` emits the Summary sheet only (CSV has no sheets); `xlsx` emits both.

**Response:** `200` — file attachment. `400` if `mfgId` is invalid; `401`/`403` per the usual auth/access rules (**including `403 out_of_scope` when `mfgId` is outside the caller's entity scope**); `500` on a server error.

---

## Admin Endpoints

Gated on the **`/admin` page slug** (`viewer` to read, `editor` to write) rather than a hardcoded role check — so admin access is itself granted from the admin panel. `/admin` has no parent slug, so it is deny-by-default; `scripts/seed-permissions.ts` and `prisma/add_activity_log.sql` seed `developer` + `admin`.

Reads for the admin screens happen **server-side** in each tab's `page.tsx` (like masters pages). These routes are mutations, plus the two permission reads the grid needs.

### `POST /api/v1/admin/users`

Create a user. Inserts `users` + one `user_roles` row per role in one transaction.

```json
// Request body
{ "name": "Asha R", "email": "asha@mcaffeine.com", "status": "active", "roles": ["rm_lead"] }

// Response 200
{ "ok": true, "user": { "id": 31, "name": "Asha R", "email": "asha@mcaffeine.com", "status": "active", "roles": "rm_lead", "last_login": null } }

// Response 409 — users.email is UNIQUE
{ "error": "A user with the email asha@mcaffeine.com already exists", "code": "duplicate", ... }
```

- **Nothing is emailed.** The row *is* the whitelist — `lib/auth.ts`' `signIn` callback matches on `email` + `status`, so the person can sign in with Google as soon as it exists. The email is lowercased on insert because `signIn` looks it up verbatim.
- `roles` is validated with `z.enum(ROLE_KEYS)` from `lib/roles.ts` and de-duplicated. Free text is rejected: the old version let a typo in the dialog create a permanent phantom role.

### `PATCH /api/v1/admin/users`

Update `name` / `status` and replace the user's roles wholesale. `404` if the id doesn't exist.

```json
{ "id": 31, "name": "Asha Rao", "status": "inactive", "roles": ["rm_lead", "cost_executive"] }
```

**There is deliberately no `DELETE`** — `users.id` is referenced by `approvals`, `sessions`, `session_history`, `master_*` and `supplier_invoices`. Deactivation is `status = 'inactive'`, which `signIn` already refuses.

### `GET /api/v1/admin/permissions`

Returns all role-page permission entries.

```json
// Response 200
[
  { "id": 1, "role": "developer", "page_slug": "/masters", "access_level": "editor" },
  ...
]
```

### `POST /api/v1/admin/permissions`

Upsert a role-page grant. Uses `ON DUPLICATE KEY UPDATE` — safe to call multiple times. `role` must be a key from `lib/roles.ts` (it used to be free text that this route didn't even lowercase, so a POST could create a row no user string would ever match, silently granting nothing).

```json
// Request body
{ "role": "rm_lead", "page_slug": "/masters", "access_level": "editor" }

// Response 200
{ "id": 45, "role": "rm_lead", "page_slug": "/masters", "access_level": "editor" }

// Response 400 — the change would remove the caller's own /admin access
{ "error": "That change would remove your own access to Administration. Ask another admin to make it.", "code": "self_lockout", ... }
```

### `DELETE /api/v1/admin/permissions`

Removes the grant so the slug **inherits from its parent** again. This is what the admin UI's "Inherit" option sends — an explicit `access_level: 'none'` row would instead *stop* the parent walk, which is a different and stronger statement.

```json
// Request body
{ "role": "rm_lead", "page_slug": "/masters" }

// Response 200
{ "ok": true }
```

### `GET /api/v1/admin/user-permissions?user_id=<id>`

Returns user-specific permission overrides. Omitting `user_id` returns all overrides.

```json
// Response 200
[
  { "id": 3, "user_id": 12, "page_slug": "/finance", "access_level": "editor" }
]
```

### `POST /api/v1/admin/user-permissions`

Upsert a user-specific permission override.

```json
// Request body
{ "user_id": 12, "page_slug": "/finance", "access_level": "editor" }

// Response 200
{ "id": 3, "user_id": 12, "page_slug": "/finance", "access_level": "editor" }
```

### `DELETE /api/v1/admin/user-permissions`

Remove a user-specific override (restoring role-based access for that page).

```json
// Request body
{ "user_id": 12, "page_slug": "/finance" }

// Response 200
{ "ok": true }
```

### `PUT /api/v1/admin/entity-scope`

Replaces **one** `(user_id, entity_type)` scope set in a transaction. The other two entity types are untouched, so the UI can save one section at a time.

```json
// Request body — restrict this user to two manufacturers
{ "user_id": 12, "entity_type": "mfg", "entity_ids": [3, 7] }

// Request body — clear the restriction (UNRESTRICTED: they see every manufacturer again)
{ "user_id": 12, "entity_type": "mfg", "entity_ids": null }

// Response 200
{ "ok": true, "entity_type": "mfg", "entity_ids": [3, 7] }

// Response 400 — you cannot change your own scope, in either direction
{ "error": "You can't change your own data access. Ask another admin to make this change.", "code": "self_scope", ... }
```

`entity_type` is `mfg` | `vendor` | `warehouse` | `brand`. `[]` is treated the same as `null` rather than as "nothing" — a scope of nothing would lock the user out of every screen with no way for them to say so. `404` if the user doesn't exist. See [Admin Panel & Data Scoping](./admin-and-data-scoping.md) for why absence of rows means unrestricted.

---

## Entity Emails

### `POST /api/v1/entity-emails`

The contact list behind every outbound mail (`/po-tracking/po-procurement/entity-emails`). Direct insert, **no approval flow** — an auxiliary contact list, not a master record. One row per address, so one entity can hold several.

```json
// A manufacturer's own contacts
{
  "entity_type": "mfg",
  "entity_code": "MFG01",
  "emails": [
    { "email": "orders@acme.com", "recipient_type": "to", "purpose": "PO" },
    { "email": "accounts@acme.com", "recipient_type": "cc" }
  ]
}

// A warehouse contact for ONE legal entity (warehouse rows only)
{ "entity_type": "warehouse", "entity_code": "Bhiwandi", "legal_entity_code": "PEP", "emails": [ … ] }

// Someone looped in on EVERY manufacturer's PO mail
{ "entity_type": "employee", "entity_code": "*", "emails": [{ "email": "ajay@mcaffeine.com", "recipient_type": "cc" }] }

// Response 200
{ "ok": true }
```

| Field | Notes |
|---|---|
| `entity_type` | `vendor` \| `mfg` \| `warehouse` \| `employee` |
| `entity_code` | The mfg/vendor **code**, or a `master_warehouse.name` — that is what `purchase_orders.destination` stores. For `employee`, what the person hangs off: a warehouse name, a mfg code, or `'*'` for **every** manufacturer including ones added later |
| `legal_entity_code` | **Warehouse rows only** — a site's point of contact can differ for Pep vs Kreative. Omitted or empty means every entity. Rejected on the other types |
| `emails[].recipient_type` | `to` (default) or `cc`. Applies to every type |
| `emails[].purpose` | Free text (`PO`, `Invoice`) |

**`employee` is a person to loop in, not an entity to write to** — one of ours or an outside party (3PL, CHA, consultant). The address is **typed, not picked from `users`**: people who need copying often hold no login here.

```json
// 400 — entity_code has no FK (it points at three tables), so it is checked here
{ "error": "'Bhivandi' is neither a warehouse nor a manufacturer.", "code": "unknown_entity", ... }
// 400 — a warehouse row naming an entity that doesn't exist
{ "error": "Unknown legal entity 'PEPP'.", "code": "unknown_entity", ... }
// 400 — a legal entity on a non-warehouse row
{ "error": "A legal entity can only be set on warehouse contacts.", "code": "validation_error", ... }
```

**How these become a mail:** `resolveRecipients` (`lib/mail/mailer.ts`) picks the query by shape — a warehouse takes its own rows plus employees at that site; a manufacturer takes its own plus employees attached to it, plus the `'*'` wildcard. Then `splitRecipients` (`lib/mail/recipients.ts`) returns `{ to, cc }`. An address listed both ways is sent **once, in To**. `cc` is omitted from the message entirely when empty, because nodemailer throws on a blank `Cc`.

---

## Invoice Inwarding Endpoints

Full flow documented in [PO Inwarding](./po-inwarding.md).

### `POST /api/v1/purchase-orders/invoice/parse`

Multipart (`file`) → parse a supplier-invoice PDF with Nanonets and return the fields for review. Nothing is stored: the PDF is not written to S3 here, so an abandoned review leaves no orphaned object.

```json
// Response 200
{ "ok": true, "parsed": { "invoice_number": "INV-001", "date": "05-Jul-25", "line_items": [ ... ], ... } }
```

`400` empty / non-PDF / over the 10 MB cap · `422 unparseable` when nothing usable came back · `502 parse_failed` on an extractor error. `runtime = "nodejs"`, `maxDuration = 300` — extraction measures **50–70 s** on a one-page invoice.

### `POST /api/v1/purchase-orders/invoice`

Multipart (`file` = the PDF, `payload` = the reviewed invoice as JSON, validated with `invoiceInwardSchema`). Commits the whole sequence and answers with **newline-delimited JSON step events** (`application/x-ndjson`) rather than one body:

```
{"step":"s3","status":"ok"}
{"step":"po","status":"ok","data":{...}}
{"step":"uniware","status":"ok","data":{"purchaseOrderCode":"GM/2627/PO/2006"}}
{"step":"email","status":"skipped","message":"warehouse has no email on file"}
{"done":true,"outcome":{"ok":true,"created":[...],"received":[...],"uniwarePoCode":"..."}}
```

**The status is always `200` once streaming starts** — headers are on the wire before a later step can fail, so failure travels as an event (`outcome.ok = false`, `outcome.failedStep`), not a status code. Pre-flight failures (`400 sku_not_found`, `400 sku_not_active`, duplicate `(mfg_id, invoice_no)`) are also delivered as the terminal event.

### `GET /api/v1/purchase-orders/invoice`

Invoice history list, newest first. Returns `{ invoices, total, limit, offset }`.

| Query param | Notes |
|---|---|
| `limit` · `offset` | Clamped 1–100, default 25. Clamped rather than 400-ing — this is a pager, not public API surface |
| `search` | `invoice_no` or manufacturer name |
| `mfgCode` | `master_mfgs.code` |
| `destination` | A `master_warehouse.name` — `invoice_mfg.destination` has no FK |
| `dateFrom` · `dateTo` | On the **invoice date**, not the date it was entered |

Every filter is optional and each is read twice by `buildInvoiceParams` — once for an `IS NULL` check, once for the comparison — so an absent one switches its own predicate off. An empty string is coerced to NULL, or a cleared dropdown would filter on a code of `""`. `tests/unit/invoice-filters.test.ts` pins the param count against the `?` count in the SQL, which is how a positional list normally breaks.

Scoped by manufacturer, destination **and brand**. Brand is per *line* (one invoice can carry several brands' SKUs), so it's an `EXISTS … OR NOT EXISTS` pair rather than a join — a join would both drop multi-brand invoices and multiply rows against the `GROUP BY` that produces `item_count`.

### `GET /api/v1/purchase-orders/invoice/export`

The same filters, unpaginated: `?format=csv|xlsx`. CSV is the invoice summary; XLSX is two sheets — Invoices, and every line flattened with its header. The export must return what the filtered view would page through, so it shares `INVOICE_LIST_BODY` with the list.

### `GET /api/v1/purchase-orders/invoice/[id]`

One invoice: header, its line items, and the POs each line resolved to — both the inward PO it raised and the order it was received against. `404` if unknown.

### `GET /api/v1/purchase-orders/[id]/inwarding`

Everything inwarded against one PO, for the detail panel behind a PO number on the tracking screens. Returns `{ po, lines, withoutInvoice }`.

`withoutInvoice` is a **number, not a list**: both receipt paths write an identical `history_pos` row, so merging the invoice lines with the receipt log would double-count every invoice-driven receipt, and correlating them on `(qty, timestamp)` mis-pairs two equal receipts on one day. It is derived by subtraction — `received_qty` minus the invoice-linked total — which cannot double-count.

Entity-scope checked via `assertPoInScope` (**403** out of scope). A **404** means no `purchase_orders` row with that id, and the client treats it as a dead `?inwardFor=` — `useInwardingPanel` clears the param and closes the panel rather than showing an error with a Retry that can only 404 again.

### `GET /api/v1/purchase-orders/open-for-receive?mfg_id=`

Open POs (`raised` / `partially_received`) for one manufacturer, for the Add Invoice dialog's per-line **Reference PO** picker. Entity-scope checked. An unparseable/missing `mfg_id` returns `{ pos: [] }` rather than a `400` — the dialog calls it before a manufacturer has been picked.

### `GET /api/v1/files/preview?key=`

Parses a bulk-upload CSV/Excel file **server-side** (the same `parseS3Import` the bulk-approval import uses) and returns `{ headers, rows }`, so approvers see the file as a table instead of a raw download. Rejects keys containing `..`.

---

## NextAuth-Managed Endpoints

These are handled internally by NextAuth and do not have custom route files.

| Endpoint | Description |
|----------|-------------|
| `GET /api/auth/session` | Returns the current session object |
| `GET /api/auth/csrf` | Returns a CSRF token |
| `POST /api/auth/signin` | Initiates the Google OAuth redirect |
| `POST /api/auth/signout` | Clears the JWT cookie and fires the `signOut` event |
| `GET /api/auth/callback/google` | OAuth callback URL — Google redirects here after user consent |
