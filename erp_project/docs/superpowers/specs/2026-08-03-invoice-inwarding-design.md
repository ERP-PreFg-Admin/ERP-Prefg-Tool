# Add Invoice → auto-raise Inward POs (PO Inwarding page) — Design

**Date:** 2026-08-03
**Status:** awaiting approval

## Goal

An **Add Invoice** button on `/po-tracking/po-inwarding` that takes a PDF invoice,
stores it in S3, parses it with Nanonets, shows PDF-vs-parsed-fields side by side for
manual correction, and on OK creates one Inward PO per line item against the selected
manufacturer + destination, with the S3 PDF attached.

---

## Verified facts (probed live against the real API today)

The committed `scripts/invoice_reading_nanonets.js` **does not work** — it posts to
`/api/v2/parse/sync`, which only emits markdown/html and silently ignores
`EXTRACTION_SCHEMA`. Its own comment says so and then calls the wrong URL anyway. The
working-tree copy is a further regression (hardcoded key, `headers: {}` with a dangling
`Authorization` line — a syntax error).

The real contract, confirmed from `https://extraction-api.nanonets.com/openapi.json`
and two live calls against `Invoices/Sales_RP_L_26-27_482 (1).pdf`:

```
POST /api/v2/files                       (multipart: file)
  → 201 { success, file_id: "file://<uuid>", filename, content_type, file_size }

POST /api/v2/extract/sync                (Bearer + application/json)
  { input: "file://<uuid>",
    extraction_config: {
      output_format: "json",             // ExtractFormat: json | csv
      json_options: <JSON-schema dict>,  // ← the schema goes HERE
      custom_instructions: "<string>",   // ≤ 8000 chars
      prompt_mode: "append"              // append | replace
    } }
  → 200 { success, record_id, file_id, status, processing_time,
          result: { content: { …exactly the shape of json_options… } } }
```

Second call returned the schema honoured exactly:

```json
{ "date": "10-Jun-26", "invoice_number": "RP/L/26-27/482",
  "eway_bill_number": "292220364349", "from": "REVE PHARMA",
  "destination": "Guwahati", "vehicle_number": "MH48AG3908",
  "currency": "INR", "seller_gstin": "27AAKFR0481L1ZT",
  "buyer_gstin": "18AAICP2804J1ZB", "total_amount": 123372,
  "line_items": [
    { "sku_code": "Mcaf407", "sku_name": "Caramal Eclairs Coffee Body Scrub 175gm",
      "batch": "AMCES-010", "mfg_date": "01-Jun-26", "expiry": "31-May-28",
      "qty": 640, "hsn": "33049990", "rate": 69.21, "mrp": null, "discount": null,
      "amount": 44294.4, "gst_percent": 18, "total_amount": null, "_ref": "v1" },
    …
  ] }
```

Three consequences that shape the design:

1. **Extraction takes 53–68 seconds.** Not a spinner-for-two-seconds feature. Upload and
   parse have to be separate phases with separate progress states (which is what the
   brief asks for anyway).
2. Nanonets injects a `_ref` key into each line item — strip it.
3. `sku_code` comes back as `"Mcaf407"` / `"MCaf396"` — a supplier's code, not necessarily
   a `master_skus.sku_code`. Mapping is a real step, not a formality.

## What's already here and gets reused unchanged

| Need | Existing thing |
|---|---|
| PDF → S3 | `POST /api/upload` (multipart, already allows `application/pdf`, 10 MB cap) |
| Signed URL for viewing | `GET /api/files/presign?key=…` |
| S3 read for the parser | `getFileBuffer(key)` in `lib/s3.ts` |
| Auth + Zod + logging on routes | `withGateway` |
| SKU / MFG / warehouse dropdown data | `getPoDropdownOptions()`, already fetched by the page and passed into `PoProcurementClient` |
| Fuzzy option picker | `components/ui/FuzzySelect` (Fuse.js, already a dependency) |
| PDF viewer with scroll + zoom | the browser's own, via `<iframe src={signedUrl}>` |

No new dependencies. No pdf.js.

---

## Changes, file by file

### 1. `lib/env.ts` — one line

```ts
export const NANONET_API_KEY = required("NANONET_API_KEY")
```

Already present in `.env`.

### 2. `lib/nanonets.ts` — NEW, the single parsing service

The one place that knows the Nanonets wire format. Exports the schema, the custom
instructions, and:

```ts
export async function parseInvoice(buffer: Buffer, filename: string): Promise<ParsedInvoice>
```

Upload → extract → strip `_ref` → return `result.content`. Throws a plain `Error` with
the upstream status + body on failure, so the route can turn it into an `ApiError` the
dialog can show next to a Retry button. Schema is the committed one plus the fields the
brief asks for: `currency`, `seller_gstin`, `buyer_gstin`, `total_amount`, and per-line
`mrp` / `discount`.

`types/invoice.ts` gets the `ParsedInvoice` / `ParsedLineItem` row types (alongside the
existing `types/masters.ts`).

### 3. `scripts/invoice_reading_nanonets.js` → `scripts/invoice_reading_nanonets.ts`

Becomes a ~10-line CLI over `parseInvoice()` — `npx tsx scripts/invoice_reading_nanonets.ts <pdf>`.
Deletes the duplicated (and broken) fetch code, which is the brief's "do not duplicate
parsing logic" requirement. **This overwrites your uncommitted edits to that file** —
those edits are the regression described above, but say the word if you want them kept.

### 4. `POST /api/purchase-orders/invoice/parse` — NEW

Body `{ key }`. Pulls the PDF from S3 with `getFileBuffer`, calls `parseInvoice`, returns
`{ ok, parsed }`. Retry from the UI is just calling this again with the same key — the
PDF is already in S3, so a retry never re-uploads.

`export const maxDuration = 300` — the parse takes ~60 s and this must not be cut off.

### 5. `POST /api/purchase-orders/invoice` — NEW, creates the POs

Body (Zod-validated in `lib/validation/purchase-orders.ts`):

```ts
{ attachment_key, invoice_no, invoice_date?, mfg_id, destination,
  line_items: [{ sku_code, qty, unit_price?, total_amount? }] }   // min 1
```

One transaction, one `purchase_orders` row per line item, each carrying the same
`invoice_no` and `attachment_key`. Validates every `sku_code` exists and is `active`
first (the existing `skusSql.selectStatusAndBrandByCode` check, applied per row) and
fails the whole batch if any is bad — a half-created invoice is worse than a rejected one.

`po_no` uses the existing brand-scoped generator with a new `INW` tag:
`{BRAND}-INW-{yyyymm}-{nnn}`. Writes an `insertPoHistory` "create" row per PO and a
`PO_INVOICE` event, matching the other PO writes.

New SQL in `lib/queries/purchase-orders.ts`: `insertInward` (status + `invoice_no` +
`attachment_key` as parameters).

### 6. `AddInvoiceDialog.tsx` — NEW, in `app/po-tracking/po-inwarding/`

Four states in one dialog:

- **pick** — drop zone, `accept="application/pdf"`, client-side reject of non-PDF and
  >10 MB before any network call.
- **uploading** — real percentage from `XMLHttpRequest.upload.onprogress` (`fetch` can't
  report upload progress).
- **parsing** — indeterminate bar + elapsed-seconds counter and an up-front "this
  usually takes about a minute" line, because it does. On failure: the error text and a
  **Retry** button that re-hits the parse route with the same key.
- **review** — the split screen, `max-w-[95vw] h-[90vh]`, `<iframe>` PDF on the left
  (browser viewer = scroll + zoom + page nav for free), scrollable editable form on the
  right. Below `lg` the two panels stack instead of squeezing.

Right panel, all editable:

| Group | Fields |
|---|---|
| Header | Invoice No\*, Invoice Date, Currency, E-way Bill, Vehicle No |
| Parties | Manufacturer\* (`<select>` over `mfgOptions`), Destination\* (`<select>` over `warehouseOptions`), Seller GSTIN, Buyer GSTIN, raw parsed "From" shown read-only as the matching hint |
| Line items | editable table — SKU\* (`FuzzySelect`), Product Name, Batch, HSN, Qty\*, Rate, MRP, Discount, GST %, Amount, Line Total, ✕ remove; **+ Add row** below |
| Totals | Invoice Total (editable), plus a live sum of the line rows next to it so a mismatch is visible |

Anything the parser returned that isn't in that list is rendered in a collapsible
**Other parsed fields** section as editable key/value pairs, so partial or
unexpected output is never silently dropped.

Pre-mapping on entry to review, all overridable:

- Manufacturer — Fuse match of parsed `from` against `mfgOptions` name/code.
- Destination — Fuse match of parsed `destination` against `warehouseOptions`, else the
  default MWH (same fallback `ImpromptuPODialog` uses).
- Per line SKU — Fuse match of `sku_code` then `sku_name` against `skuOptions`. Unmatched
  rows get an amber "map this SKU" marker and block OK.

OK is disabled until: invoice no non-empty, mfg selected, destination selected, ≥1 line
item, and every line has a mapped SKU and qty > 0.

### 7. `PoProcurementClient.tsx` — the button

Inside the existing `mode === "inwarding"` branch that today renders nothing on the
toolbar, add an `Add Invoice` button (`sm:ml-auto`) and render `AddInvoiceDialog` in the
`isInwarding` arm of the dialogs block, wired to `router.refresh()` on success. It
already receives `skuOptions` / `mfgOptions` / `warehouseOptions`, so no prop threading.

### 8. Docs

`docs/api-reference.md` gets the two new routes; `docs/s3-integration.md` gets the
`invoices/{yyyy-mm}/` key prefix.

---

## Decisions (confirmed 2026-08-03)

**"Inward PO" is a new `po_type`, not a status.** Chosen over reusing the `punched`
status, so inward POs are queryable and reportable independently of where they are in
the receiving lifecycle. That means:

```sql
ALTER TABLE purchase_orders
  MODIFY COLUMN po_type ENUM('normal','impromptu','inward') DEFAULT 'impromptu';
```

plus the matching `prisma/schema.prisma` `purchase_orders_type` enum, `PoRow["po_type"]`
in `po-types.ts`, and an "Inward" option in the PO Type filter dropdown.

New rows are created as **`status = 'raised'`, `po_type = 'inward'`** — `raised` is in
`RECEIVABLE` and in the Open tab, so the invoice-created POs show up on the inwarding
desk ready to receive against, which is the point.

**`received_qty` stays 0.** Creating the PO is not receiving against it; the desk still
clicks Receive so the recorded number is the physical count, not what the invoice
claimed was shipped.

## Assumptions I'm making unless told otherwise

- **No approval flow.** POs are created directly, like `po_type: "normal"`. The invoice
  is the authorisation. (Impromptu POs need approval; these don't, by my reading of
  "a po gets raised".)
- **`expected_on` = the invoice date** (or today if the parser missed it). These are
  retroactive POs for goods already shipped, so the existing "no backdating" rule that
  `poCreateSchema` enforces must *not* apply here — hence a separate schema rather than
  extending `poCreateSchema`.
- **`unit_price` comes from the invoice**, not from `useQuotedRate`. The invoice is the
  source of truth for what was actually billed.
- Only the original PDF goes to S3, at `invoices/{yyyy-mm}/{invoice-no-or-uuid}.pdf`. The
  parsed JSON is not stored as a file; the edited values land in the PO rows.

## Verification

- `scripts/_check-invoice-mapping.ts` — assert script (`npx tsx`), matching the existing
  `_check-po-status-filter.ts` pattern: feeds the real Nanonets response captured above
  through the pure mapping helpers and asserts `_ref` is stripped, both line items
  survive, `qty`/`rate` are numbers, and the fuzzy SKU matcher picks the right
  `master_skus` row for `"Mcaf407"`. No network, no DB.
- `npm run build` and `npm run lint` clean.
- Manual: upload `Invoices/Sales_RP_L_26-27_482 (1).pdf`, confirm both line items render,
  correct a SKU, OK, then confirm two POs appear on the Inwarding page sharing one
  invoice number with Review PDF opening the original.

## Risk

`lib/queries/purchase-orders.ts` is shared with FG POs Tracking and the PO export — but
this only *adds* an `insertInward` statement, no edits to `buildFilterParams` or the
WHERE clauses, so nothing existing shifts. The genuine risk is the 60-second parse: if
anything in front of Next.js (the EC2 reverse proxy) has a shorter idle timeout, the
parse request dies before Nanonets answers. Worth checking the proxy config before we
ship, and the fallback is `/api/v2/extract/async` + polling.
