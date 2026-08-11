# S3 Integration — Change Reference

This document lists every file that was created or modified as part of the Amazon S3 integration. Use it as a checklist when reviewing, debugging, or extending the feature.

---

## Environment Variables Required

Add these four variables to `.env` before running the app:

```bash
AWS_REGION="ap-south-1"
AWS_ACCESS_KEY_ID="AKIA..."
AWS_SECRET_ACCESS_KEY="..."
AWS_S3_BUCKET_FILES="mcaffeine-erp-files"    # CSV/Excel/PDF uploads, PO attachments
AWS_S3_BUCKET_EVENTS="mcaffeine-erp-events"  # raw-events, processed-events, failed-events
```

---

## Database Migration Required

Run these SQL statements against MariaDB **once** to add all PO-related columns:

```sql
-- PO file attachment
ALTER TABLE purchase_orders
  ADD COLUMN attachment_key TEXT NULL AFTER reason;

-- PO type flag (normal vs impromptu)
ALTER TABLE purchase_orders
  ADD COLUMN po_type ENUM('normal','impromptu') NOT NULL DEFAULT 'impromptu' AFTER status;

-- Track which bulk-CSV S3 key this PO was created from (null for manual POs)
ALTER TABLE purchase_orders
  ADD COLUMN csv_source_key TEXT NULL AFTER po_type;

-- Email send timestamp (stamped on first send only)
ALTER TABLE purchase_orders
  ADD COLUMN email_sent_at DATETIME NULL AFTER csv_source_key;
```

Then regenerate the Prisma client:

```bash
npm run db:generate
```

---

## New Files

### `lib/s3.ts`
Core S3 utility. Exports two sets of functions — one per bucket.

| Export | Bucket | Purpose |
|--------|--------|---------|
| `uploadFile(buffer, key, mimeType)` | FILES | Upload a buffer; returns the key |
| `deleteFile(key)` | FILES | Delete an object (idempotent) |
| `getPresignedUploadUrl(key, mimeType, expiresIn?)` | FILES | Signed PUT URL for direct browser upload |
| `getPresignedDownloadUrl(key, expiresIn?)` | FILES | Signed GET URL for viewing private files (1 hr default) |
| `getFileBuffer(key)` | FILES | Fetch object as a Node Buffer (used by import parser) |
| `putEvent(key, payload)` | EVENTS | Fire-and-forget event write; never throws |
| `getEvent(key)` | EVENTS | Fetch and parse an event JSON object |

---

### `lib/events.ts`
Thin wrappers over `putEvent` for structured event logging. Import and call from any API route to record what happened before and after a DB write.

```typescript
import { recordRawEvent, recordProcessedEvent, recordFailedEvent } from "@/lib/events"

// Before DB write
recordRawEvent("VENDOR", eventId, requestPayload)

// After successful DB write
recordProcessedEvent("VENDOR", eventId, requestPayload)

// After error
recordFailedEvent("VENDOR", eventId, requestPayload, err.message)
```

S3 key pattern: `{raw|processed|failed}-events/{module}/{eventId}.json` — the key is derived directly from `eventId`, the same id passed to `logger.info`/`logger.error`, so a logged eventId always resolves to the exact object (no separate random id, no need to know the date to search). Build `eventId` with `makeEventId(module, action, ref?)` from `lib/events.ts` rather than a hand-rolled template string.

---

### `lib/import-s3.ts`
Server-side file parser. Fetches a file from the files bucket by its S3 key and returns rows as `Record<string, string>[]`.

Supports: `.csv`, `.xlsx`

```typescript
import { parseS3Import } from "@/lib/import-s3"

const rows = await parseS3Import("imports/vendors/import_1234567890.csv")
// rows = [{ code: "VEN-001", name: "Acme", type: "rm", ... }, ...]
```

Used by the `bulk_from_s3` action in master API routes (currently wired in vendors only — see below for how to add to other routes).

---

### `lib/queries/s3-files.ts`
SQL for S3 attachment operations. Kept separate from other query files so S3-related DB work is easy to find.

| Query | Purpose |
|-------|---------|
| `updatePoAttachment` | `UPDATE purchase_orders SET attachment_key = ? WHERE id = ?` |
| `getPoAttachment` | `SELECT attachment_key FROM purchase_orders WHERE id = ?` |

To add attachment support to another entity (e.g. invoices), add new queries here.

---

### `app/api/v1/upload/route.ts`
`POST /api/v1/upload` — accepts `multipart/form-data`, uploads to the files bucket, returns `{ key }`.

**Form fields:**

| Field | Type | Example |
|-------|------|---------|
| `file` | Blob | the file |
| `folder` | string | `attachments/purchase-orders/42` |
| `field` | string | `attachment` |

**Allowed types:** `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `.xlsx`, `.csv`

**Size limit:** 10 MB

**Returns:** `{ key: "attachments/purchase-orders/42/attachment.pdf" }`

---

### `app/api/v1/files/presign/route.ts`
`GET /api/v1/files/presign?key=...` — auth-gated, returns a 1-hour signed URL for viewing any file in the files bucket.

**Query param:** `key` — the S3 object key (e.g. `attachments/purchase-orders/42/attachment.pdf`)

**Returns:** `{ url: "https://..." }`

**Security:** rejects keys containing `..` (path traversal guard). Auth required — 401 if no session.

---

### `components/ui/FileUpload.tsx`
Reusable `"use client"` component. Handles upload, progress, view, and remove.

```typescript
import { FileUpload } from "@/components/ui/FileUpload"

<FileUpload
  currentKey={existingKey}             // string | null
  folder="attachments/purchase-orders/42"
  field="attachment"
  label="PO Attachment"
  accept="document"                    // "image" | "document" | "any"
  disabled={false}
  onChange={(key) => handleKeyChange(key)}  // called with new key or null on remove
/>
```

**Three visual states:**
1. Empty — dashed drop zone with "Choose file" button
2. Uploading — progress bar with percentage (uses XHR for upload progress tracking)
3. Has file — filename chip with View (opens presigned URL in new tab) and Remove buttons

**View flow:** calls `GET /api/v1/files/presign?key=...` → opens signed URL in new tab. No full URL is stored in the DB — only the key.

---

## Modified Files

### `next.config.ts`
Added AWS SDK packages to `serverExternalPackages` so Next.js does not attempt to bundle them into the client-side bundle:

```typescript
serverExternalPackages: [
  "mysql2", "@react-pdf/renderer", "fontkit", "pdfkit", "nodemailer",
  "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner",  // ← added
]
```

---

### `prisma/schema.prisma`
Added `attachment_key` to the `purchase_orders` model:

```prisma
model purchase_orders {
  // ... existing fields ...
  reason           String?  @db.Text
  attachment_key   String?  @db.Text   // ← added
}
```

---

### `lib/queries/purchase-orders.ts`
Added `po.attachment_key`, `po.po_type`, `po.csv_source_key`, and `po.email_sent_at` to the `selectAll` and `selectPaginated` query column lists so they are available in every `PoRow`. Also added `mfg_email` (from `details_mfg`) to power the auto-send-on-approval flow.

---

### `app/po-tracking/po-procurement/po-types.ts`
Added new fields to the `PoRow` type:

```typescript
export type PoRow = {
  // ... existing fields ...
  attachment_key:  string | null   // S3 key for attached PDF/doc
  po_type:         "normal" | "impromptu"
  csv_source_key:  string | null   // set when PO was created from a bulk CSV
  email_sent_at:   string | null   // ISO timestamp of first email send
  mfg_email:       string | null   // manufacturer contact email
}
```

---

### `app/api/v1/purchase-orders/[id]/route.ts`
Added a `PATCH` handler alongside the existing `PUT`:

```
PATCH /api/v1/purchase-orders/[id]
Body: { attachment_key: string | null }
```

- Fetches existing key from DB
- Updates `attachment_key` via `s3FilesSql.updatePoAttachment`
- Deletes the old S3 object (eager cleanup) when a key is replaced
- Fire-and-forget delete — never blocks the response

---

### `app/api/v1/masters/vendors/route.ts`
Added `action: "bulk_from_s3"` handler:

```
POST /api/v1/masters/vendors
Body: { action: "bulk_from_s3", key: "imports/vendors/file_1234.xlsx" }
```

Fetches the file from S3 via `parseS3Import(key)`, then runs the same per-row insert loop as `action: "bulk"`.

To add this to another master route (manufacturers, SKUs, etc.), copy this handler block and adjust the `insertVendor` / `insertVendorDetails` calls to the relevant queries.

---

### `app/po-tracking/po-procurement/PoTable.tsx`
- Added `AttachButton` inline component — a popover that renders `<FileUpload>` and calls `PATCH /api/v1/purchase-orders/[id]` on change
- Attach button is visible on POs with status: `raised`, `punched`, `partially_received`, `received`
- Button turns green when an attachment exists

---

### `components/masters/CsvImportDialog.tsx`
Extended to support `.xlsx` files:

- File input now accepts both `.csv` and `.xlsx`
- **CSV path** (unchanged): FileReader reads text client-side → `parseCSV()` → preview table → `action: "bulk"` JSON POST
- **Excel path** (new): file uploads to S3 via `/api/v1/upload` → key returned → `action: "bulk_from_s3"` POST → server parses via `parseS3Import`
- Excel files show "Excel file uploaded — ready to import" instead of a row preview (preview requires server-side parse)

---

## S3 Key / Prefix Conventions

| Prefix | Bucket | Usage |
|--------|--------|-------|
| `purchase-orders/{mfg_name}/{yyyy-mm}/PO-{po_no}.pdf` | FILES | Auto-generated PO PDF — uploaded on approval, attached to the email |
| `attachments/purchase-orders/{id}/{field}.{ext}` | FILES | Manual PO attachment uploaded via `FileUpload` component |
| `imports/{module}/{yyyy-mm}/{filename}_{ts}.{ext}` | FILES | CSV/Excel files for bulk imports (masters and PO bulk CSV) |
| `raw-events/{module}/{eventId}.json` | EVENTS | Pre-DB-write payloads |
| `processed-events/{module}/{eventId}.json` | EVENTS | Successful DB writes |
| `failed-events/{module}/{eventId}.json` | EVENTS | Failed DB writes |

**Module codes used in event keys:** `SKU`, `VENDOR`, `MFG`, `RM`, `PM`, `PO`, `PO_BULK`, `PO_SPLIT`.

New prefixes can be added at any time — no AWS Console changes required.

---

## How to Extend to Another Entity

### Add attachment support to a new entity (e.g. invoices)

1. Add `ALTER TABLE invoices ADD COLUMN attachment_key TEXT NULL;` and update `prisma/schema.prisma`
2. Add queries to `lib/queries/s3-files.ts`: `updateInvoiceAttachment`, `getInvoiceAttachment`
3. Add a `PATCH` handler to the invoice API route (copy the pattern from `app/api/v1/purchase-orders/[id]/route.ts`)
4. Add `<FileUpload>` to the invoice UI component

### Add Excel import to another master route

1. Add `import { parseS3Import } from "@/lib/import-s3"` to the route
2. Copy the `action: "bulk_from_s3"` block from `app/api/v1/masters/vendors/route.ts`
3. Adjust the insert queries and column mapping for the entity

### Add event recording to an API route

```typescript
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"

// Same eventId is used for logger.info(...) and the S3 key -- makeEventId()
// bakes in module + action + entity ref + timestamp so both sides carry the
// same specific, backtrackable id.
const eventId = makeEventId("MODULE_CODE", "create", entityId)

recordRawEvent("MODULE_CODE", eventId, requestBody)

try {
  // ... DB write ...
  recordProcessedEvent("MODULE_CODE", eventId, requestBody)
} catch (err) {
  recordFailedEvent("MODULE_CODE", eventId, requestBody, err.message)
  throw err
}
```
