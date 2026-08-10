# PO Inwarding — Supplier Invoices, Inward POs, and Uniware

> **Related docs:** [API Reference](./api-reference.md) · [Database Schema](./database-schema.md) · [Environment & Scripts](./environment-and-scripts.md) · design spec: [`docs/superpowers/specs/2026-08-03-invoice-inwarding-design.md`](./superpowers/specs/2026-08-03-invoice-inwarding-design.md)

The PO Inwarding screen (`/po-tracking/po-inwarding`) is the goods-receipt desk's view of purchase orders. It shows the same table, filters and sorting as FG POs Tracking — `PoProcurementClient` runs with `mode="inwarding"`, which strips the procurement-side writes (create, bulk upload, mail, split, cancel) and leaves **Receive** as the row action. It lands on the "open" tab (`raised` + `partially_received`) rather than everything ever raised, and adds an `inward` tab that filters on `po_type` rather than status, so POs an invoice booked in already-complete stay reachable.

On top of that sits **Add Invoice** — upload a supplier's invoice PDF, have it read automatically, review the fields against the original, and turn each line into an inward PO (and, where the goods were already ordered, a goods receipt against the existing PO).

---

## The Flow

```mermaid
sequenceDiagram
    participant U as User (Add Invoice dialog)
    participant P as /api/purchase-orders/invoice/parse
    participant N as Nanonets
    participant C as /api/purchase-orders/invoice (POST)
    participant S3 as S3
    participant DB as MySQL
    participant UW as Uniware
    participant M as Gmail SMTP

    U->>P: multipart PDF
    P->>N: POST /api/v2/files → POST /api/v2/extract/sync
    N-->>P: extracted fields (50-70s)
    P-->>U: { ok, parsed }
    note over U: Review side-by-side with the PDF.<br/>Fuzzy-mapped mfg / warehouse / SKUs are<br/>suggestions the user can override.
    U->>C: multipart (PDF + JSON payload)
    C->>S3: 1. store the original PDF
    C->>DB: 2. invoice header + items + inward POs + receipts (one transaction)
    C->>UW: 3. mirror as ONE Uniware PO carrying every SKU
    C->>DB: commit
    C->>M: 4. notify the receiving warehouse
    C-->>U: NDJSON step events, then { done: true, outcome }
```

### Step order is a rollback strategy, not a preference

S3 objects, Uniware POs and sent email are not transactional resources — a DB rollback cannot undo any of them. `lib/invoice-inward.ts` therefore orders the steps **least-reversible-last** and compensates on the way out:

| Step | Reversible? | On failure |
|------|-------------|-----------|
| `s3` | Yes — `deleteFile()` | Nothing else has happened yet |
| `po` | Yes — `conn.rollback()` | S3 object deleted |
| `uniware` | **No** — Uniware exposes no cancel/delete for a PO | Runs *while the transaction is still open*: if the call fails, the DB rolls back and the S3 object is removed, and nothing was created upstream because the call itself failed |
| `email` | **No** | Runs **after commit**. Failure is reported, nothing is undone — the goods are physically here; a missed notification is not a reason to discard the receipt |

The cost is row locks held across the Uniware call for a second or two. Acceptable for a desk operation at this volume; it would not be for a hot path.

### Progress is streamed, not returned

`POST /api/purchase-orders/invoice` answers with `application/x-ndjson` — one JSON object per line — so the dialog can report each stage as it lands:

```
{"step":"s3","status":"ok"}
{"step":"po","status":"ok","data":{...}}
{"step":"uniware","status":"ok","data":{"purchaseOrderCode":"GM/2627/PO/2006"}}
{"step":"email","status":"skipped","message":"warehouse has no email on file"}
{"done":true,"outcome":{"ok":true,"created":[...],"received":[...],"uniwarePoCode":"..."}}
```

The HTTP status is always `200` once streaming starts: headers are on the wire before a later step can fail, so **failure travels as an event, not a status code**. Both routes set `runtime = "nodejs"` and `maxDuration = 300`.

---

## Nanonets Extraction (`lib/nanonets.ts`)

Two calls on `https://extraction-api.nanonets.com`:

| Call | Body | Returns |
|------|------|---------|
| `POST /api/v2/files` | multipart | `{ file_id: "file://<uuid>" }` |
| `POST /api/v2/extract/sync` | JSON | `{ result: { content: <our schema> } }` |

Two things that are easy to get wrong:

- It must be **`/extract/sync`, not `/parse/sync`**. `parse` only emits markdown/HTML and ignores the schema entirely, silently returning prose instead of fields.
- The schema travels as `extraction_config.json_options` (verified against the API's own `openapi.json` → `ExtractConfig`).

`EXTRACTION_SCHEMA` mirrors `types/invoice.ts`: header fields (invoice number/date, e-way bill, vehicle number, currency, both GSTINs, bill-to/ship-to blocks, buyer PO reference, grand total) plus `line_items[]` (item code, description, batch, mfg/expiry, HSN, qty, rate, MRP, discount, GST %, amount, total). `normalizeParsedInvoice` coerces the response into `ParsedInvoice`.

**Extraction takes 50–70 seconds on a one-page invoice.** Every caller has to be built for that: no default fetch timeouts, and a UI that says so.

## Fuzzy Mapping (`lib/invoice-mapping.ts`)

A supplier writes "REVE PHARMA", "Guwahati" and "Mcaf407"; the masters hold a manufacturer row, a warehouse row and a `master_skus` row whose codes rarely match character-for-character. `matchMfg` / `matchWarehouse` / `matchSku` pick the most likely master record so the review form opens pre-filled.

- Uses **Fuse.js** (already a dependency via `components/ui/FuzzySelect`), threshold `0.3` — deliberately tighter than FuzzySelect's browsing threshold of `0.4`, because this picks a value on the user's behalf and a confidently wrong guess costs more than a blank field.
- Exact case-insensitive hits short-circuit Fuse, so a supplier code that already equals a master code can never lose to a fuzzier-but-shorter candidate.
- `matchSku` tries the code first (more discriminating), and only falls back to the product name when the code finds nothing.
- `matchMfg` tries **`registered_name` before `name`**: an invoice header prints the legal entity ("REVE PHARMACEUTICALS PVT LTD") where `master_mfgs.name` is the short form we type internally ("Reve"), and the fuzzy pass often couldn't bridge that gap. `registered_name` comes from `details_mfg` via `purchaseOrdersSql.mfgOptions`. Every field gets its **exact** comparison (`exactMatch`) before any field gets a fuzzy one, so a code or short name that already matches character-for-character can't lose to a merely-plausible registered-name hit; the fuzzy pass then runs in the same priority order.
- Pure and network-free, so `scripts/_check-invoice-mapping.ts` exercises it directly.

**Every result is a suggestion, never a silent commit.**

---

## The Add Invoice Dialog

`app/po-tracking/po-inwarding/` — three phases in one dialog (`pick` → `parsing` → `review`), split across files so the orchestration reads as phases rather than fetches:

| File | Responsibility |
|------|----------------|
| `AddInvoiceDialog.tsx` | Orchestration only — phases, step toasts, submit |
| `invoice-form.ts` | Form model, builders, derived values and `collectProblems` validation. React-free, so the parsed → reviewable mapping can be read and exercised without rendering |
| `invoice-api.ts` | The three requests (`parseInvoiceFile`, `fetchOpenPos`, `commitInvoice`), throwing `InvoiceApiError` with the server's own message |
| `invoice-draft.ts` | Crash/close recovery — checkpoints the whole review, PDF included, to IndexedDB |
| `InvoiceFields.tsx` / `InvoiceLineItems.tsx` | The two halves of the review pane |
| `useSplitPane.ts` | Drag-to-resize split between the PDF preview and the form |
| `InvoiceHistoryDialog.tsx` | Past invoices, expanding to line items and the POs each line resolved to |

**Nothing is persisted server-side until "Create Inward POs".** The PDF is posted straight to the parser and previewed from a local blob URL; the S3 upload is the first step of submit. Abandoning a review leaves nothing on the server. The cost is that a parse **Retry** re-posts the file.

**Why IndexedDB, not localStorage:** extraction takes ~60s and the review that follows is real work, so losing it to a stray Escape is expensive. The PDF has to survive too — localStorage holds ~5 MB of *strings* and a 10 MB PDF is ~13 MB once base64'd. IndexedDB stores a `File` directly, no encoding, with a quota measured against free disk. Every draft operation is best-effort: storage can be unavailable (private mode, blocked cookies, quota exhausted) and a draft that fails to save must never take the invoice flow down with it.

### Per-line "Reference PO" and the FIFO match

Every line points at an existing open PO (`raised` or `partially_received`) for that manufacturer, fetched on demand from `GET /api/purchase-orders/open-for-receive?mfg_id=`. That's fetched on demand rather than shipped with the page because the manufacturer isn't known until the invoice has been parsed, and every open PO for every manufacturer would be most of the PO table. **Which** PO is decided by the FIFO match below, not by the user.

When a line references a PO, it **still raises its own inward PO** *and* books a goods receipt against the referenced one — so the line carries two PO links (see `link_type` below).

**A reference PO is mandatory** (since 2026-08-07), in `invoiceInwardSchema` as well as the dialog. There is no longer a path through this endpoint for inwarding goods against no order at all.

The references are chosen by `allocateFifo` (`invoice-form.ts`), not by hand:

- Open POs are bucketed by SKU and consumed **oldest `purchase_orders.date` first** — the raise date, not `expected_on`. `openForReceiveByMfg` sorts the same way so the picker never contradicts the allocator.
- A line whose quantity no single PO covers is **split into one row per PO consumed**. The payload and `supplier_invoice_items` carry exactly one reference PO per line, so an allocation *is* a line — no nested `allocations[]`, no schema change. `Row.line_key` ties the splits back to the printed line, and `allocateFifo` merges on it before re-allocating, which is what makes re-matching idempotent.
- `amount` / `total_amount` are pro-rated by quantity share across a split, last chunk taking the rounding remainder so the invoice total doesn't drift. Per-unit fields (`rate`, `mrp`, `discount`, `gst_percent`) are copied, never divided.
- A PO's remaining quantity is tracked across the **whole invoice**, so two lines for the same SKU can't both claim it.
- A quantity the open POs can't cover stays as a row with **no** reference PO, plus a shortage message. That one leftover row is what blocks submit — "not enough POs" and "reference PO missing" are deliberately the same mechanism, not two.

It runs when the open-PO list arrives (the same moment `changeMfg` invalidates every existing reference), and from the **Re-match POs (FIFO)** button. Not on every keystroke: that would re-split rows out from under someone typing a quantity. A qty edit that breaks an allocation is caught instead by the outstanding-quantity check, which is aggregated **per PO** — after a split two rows legitimately share one PO, and comparing each row alone would pass while the pair overdraws it.

**The desk does not choose the PO.** The Reference PO cell is read-only — it states the PO the FIFO match assigned and why (`oldest open PO · raised 2026-01-14`). A picker that could undo the allocation invites exactly the inconsistency the match exists to remove.

The **one** exception is a genuine ambiguity the data can't resolve: **a SKU with more than one live BOM**. This is a fast-moving system where `effective_till` is often left unset, so an `active` BOM and the `discontinued` one it superseded stay producible together through a transition (the same rule `bomSql.selectSkusWithMultipleLiveBoms` encodes: `status IN ('active','discontinued') AND effective_from <= CURDATE()`, ignoring the unreliable `effective_till`). FIFO cannot tell those POs apart and the desk can, so those lines — and only those — get a picker, **filtered to that SKU's own POs**, captioned `2 BOM versions live — pick the right PO`.

`purchase_orders.bom_id` is now stamped at creation (see below), but **`live_bom_count` stays the trigger**. Switching it to "these POs carry different `bom_id`s" would read 0 distinct ids across a set of legacy NULLs and quietly stop asking, in exactly the case where the versions are indistinguishable and the question most needs asking.

The **BOM Code** column prefers the PO's own stamped `bom_id` and falls back to the SKU's live BOM(s), comma-joined when there is more than one. `openForReceiveByMfg` carries `bom_code` and `live_bom_count` together, so the client needs no second round trip to decide which cells get a picker.

### `purchase_orders.bom_id` — stamped at creation

The column had existed since the schema was written and no INSERT had ever populated it. Every PO creation path now does (`lib/queries/purchase-orders.ts`, `BOM_ID_FOR_LINE`).

**Why stamp instead of resolving at read time:** `master_skus.active_bom_id` moves when a new version goes live, so reading through it makes every historical PO claim the *current* recipe. Freezing the value at creation is the only thing that lets two open POs for one SKU be told apart after a version change.

**Which BOM:** the manufacturer's own live production line for that SKU — the same `(mfg, sku) → bom_id` mapping `/api/purchase-orders/quote-rate` already prices the PO from, so a row's `bom_id` and its `unit_price` cannot describe different recipes. Live follows `manufacturingSql.selectLiveLinesByMfg` (`active` or `discontinued`, since a discontinued line can still be raised against); `active` sorts first so a new PO takes the current recipe during a transition.

| Path | `bom_id` |
|---|---|
| `insert` (impromptu draft), `insertNormal`, `insertBulkPo`, `insertInward` | Resolved from the live line |
| `insertSplit` | **Inherited from the parent** — a split divides one order, it doesn't raise a new one, so a child must not pick up a version the parent never had |
| `insertInwardReceived` | **Inherited from the order being settled** (via `receivePo`'s new `bom_id`) — goods made months ago under the previous recipe must not be stamped with today's |
| `updateDraft` | Re-resolved — this is the one edit that can change the SKU or manufacturer, either of which would leave the stamped BOM describing an order that no longer exists |

Both inherited paths `COALESCE` to the live-line resolver, because parents raised before this existed carry NULL. Anything with no live line resolves to NULL, which is what the column held before — nothing regresses.

`bom_id` is the **last column** on every insert, so its resolver params append to the existing array rather than being threaded into the middle of it, where a miscount would silently shift every following value by one.

### Saying what matched

The dialog used to report only problems, which left "nothing is wrong" and "nothing has been checked" looking identical — and the FIFO match in particular does real work nobody asked for and can't otherwise see. Three confirmations balance that:

- The manufacturer field: `✓ Matched from invoice: REVE PHARMACEUTICALS PVT LTD` in green, `⚠ No match` in amber.
- Each SKU cell: `✓ matched from "Mcaf407"` under the picker when the fuzzy map landed on something.
- Green chips beside the problem chips in the commit bar: `Manufacturer matched` · `All 4 SKUs matched` · `5 POs matched by FIFO`. Counted over printed invoice lines (`line_key`), not allocation rows — one line split across three POs is still one SKU that matched.

`collectProblems` names what the invoice printed when a fuzzy match found nothing — `"REVE PHARMA" doesn't match any manufacturer in the system.`, `Row 3: "Mcaf407" doesn't match any SKU in the system.` — because a match that found nothing is a different problem from a field the user simply hasn't filled in.

---

## What Gets Written

| Table | Rows |
|-------|------|
| `supplier_invoices` | One header per invoice. `UNIQUE (mfg_id, invoice_no)` — re-submitting the same invoice is a DB error rather than a second round of credited `received_qty`. Keyed on both columns because two manufacturers can each legitimately issue "INV-001". |
| `supplier_invoice_items` | One row per invoice line, carrying both the printed value (`parsed_sku_code`) and the mapped one (`sku_code`) |
| `purchase_orders` | One inward PO per line, `po_type = 'inward'`, numbered `<BRAND>-INW-<YYYYMM>-<NNN>`. `expected_on` is the **invoice's own date** (backdated on purpose: the goods have already shipped) |
| `history_pos` | The audit row each receipt writes, via `lib/po-receive.ts` |

`supplier_invoice_items` holds two PO links, because a line can relate to two orders:

| Column | Meaning |
|--------|---------|
| `po_id` | The inward PO **this line raised** (always set for new rows) |
| `received_against_po_id` | The pre-existing PO it was **booked against**, when there is one |
| `link_type` | `created` = a plain inward line · `received` = it also credited an existing order |

The inward PO is inserted one of two ways:

| Line | Insert | Status |
|------|--------|--------|
| Plain inward line | `insertInward` | `raised` |
| Line that also references an existing PO | `insertInwardReceived` — `received_qty = qty`, `reference_po` = the parent's `po_no` | `received` (booked straight in as fully received: the goods are physically here, which is the whole point of the invoice) |

Referenced lines take their brand from the parent PO's number rather than the SKU, because such a line needn't carry a SKU at all.

`mfg_date` / `expiry` are `VARCHAR`, not `DATE`: invoices often print them month-only (`Jun-2026`).

Before any transaction opens, `resolveBrands` validates every mapped SKU — an unknown code is a `400 sku_not_found`, and a SKU that isn't `active` is a `400 sku_not_active`. Inward PO numbers use the same brand-code mapping as procurement's single-PO route, so an inward PO number is recognisable alongside the ones procurement raises.

### Shared receive logic (`lib/po-receive.ts`)

`receivePo(conn, poId, qty, userId)` credits `received_qty`, auto-closes the PO once the remainder falls inside `poTolerance`, and writes the `history_pos` row. It was extracted from the manual receive route so the automated path credits quantities exactly the same way — two copies of the tolerance/auto-close rule would eventually disagree, and the automated path is the one nobody watches.

- Receivable statuses: `raised`, `punched`, `partially_received` (`punched` because the manual desk flow has always allowed it).
- `SELECT ... FOR UPDATE` holds the row for the rest of the transaction, so a concurrent receipt blocks instead of reading a stale `received_qty`.
- It takes an already-open connection and **never** calls `beginTransaction`/`commit`/`rollback` — the route owns the transaction (see CLAUDE.md's nested-transaction rule).

---

## Uniware (Unicommerce) Mirror — `lib/uniware.ts`

Our model is **one PO per SKU**; Uniware's mirror is **one PO carrying every SKU on the invoice**. That code is stamped onto every inward PO row (`purchase_orders.uniware_po_code`) as well as the invoice header (`supplier_invoices.uniware_po_code`), so the PO list — the hottest query on that table — doesn't grow a join.

| Call | Purpose |
|------|---------|
| `POST /oauth/token?grant_type=password` | Sign in (credentials in the query string; this endpoint ignores a form body) |
| `GET /oauth/token?grant_type=refresh_token` | Renew, 300s ahead of real expiry so a request can't carry a dying token |
| `POST /services/rest/v1/purchase/purchaseOrder/create` | Create the PO |
| `GET` PO document | `fetchPurchaseOrderPdf(code)` — attached to the warehouse email |

Two traps this module exists to contain:

1. **Uniware answers HTTP 200 with `{ successful: false, errors: [...] }` on a business failure.** `res.ok` is not a success check here.
2. **`purchaseOrder/create` is facility-scoped** — the `Facility` header decides where the PO lands, unlike the facility-agnostic Item Master export.

The code is stamped onto every inward PO the invoice created (`buildSetUniwarePoCode`) **after the mirror succeeds but inside the same transaction**, so no row ever commits quoting a Uniware PO that doesn't exist.

We deliberately **do not** send our own `purchaseOrderCode` on create: leaving it out lets the facility's own series number the PO (e.g. `GM/2627/PO/2006`), which is the reference the manufacturer recognises and the one quoted in the notification email. It exists nowhere else, which is why it is stored.

Because one Uniware PO settles several of ours, it carries a **`ReferenceOrder`** custom field: a single comma-separated list of the `purchase_orders.po_no` values the goods were inwarded against (deduped, in line order — a FIFO split means several invoice lines can settle the same PO). It travels in `customFieldValues` rather than as a body key, because `buildPurchaseOrder` only forwards documented keys and Uniware rejects the rest. If the facility hasn't got that custom field configured, moving it into the body payload is a one-line change.

`uniwareEnabled()` is false when the `UNIWARE_*` vars are unset, and the mirror step is then **skipped** rather than failing — the app boots and inwards invoices without Uniware configured.

> ⚠️ `UNIWARE_VENDOR_CODE` defaults to `Test_Vendor` and `UNIWARE_FACILITY` to `TEST_FACILITY`. Uniware vendors are configured per facility and are **not** the same identifier as `master_mfgs.code` (pushing that fails with `Vendor [MFG-002-AJA] is not configured for the facility`). Until a real mfg → vendor mapping exists, both **must** be overridden before going live or every PO lands against the test vendor.

## Warehouse Notification — `sendInwardInvoiceEmail`

Deliberately not `sendMfgSelectionEmail`: that one reports PO status *to the manufacturer* and attaches PO documents we generate. This one goes to the **receiving warehouse** — the manufacturer already knows the order and shipped the goods; it's the warehouse that needs the paperwork for stock arriving at their door.

- Recipients: `entity_emails` rows with `entity_type = 'warehouse'` and `entity_code` = the `master_warehouse.name` that `purchase_orders.destination` stores. (The column was `ENUM('vendor','mfg')`, so inserting `'warehouse'` was silently coerced to `''` — widened by `prisma/add_warehouse_entity_email_type.sql`.)
- Attachments: the original invoice PDF, plus the Uniware PO document when it can be fetched (best-effort — the goods are already booked).
- Subject: `Create PO : <MFG NAME> || Invoice No : <no> || <D-MON-YY>`, left as the MIS team wrote it.
- Signed with the filer's own name plus `MAIL_SIGNATURE_TITLE` (default `MIS Executive`).
- **No recipients on file returns `false`, it does not throw** — a warehouse with no email is a data gap, not a failure of an already-committed invoice.

---

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/purchase-orders/invoice/parse` | Multipart PDF → `{ ok, parsed }`. `422 unparseable` when nothing usable came back (wrong file, unreadable scan) rather than an empty success the user has to diagnose from a blank form. `10 MB` cap, PDF only. |
| `POST /api/purchase-orders/invoice` | Multipart (`file` + JSON `payload`) → NDJSON step stream. Validated with `invoiceInwardSchema`; no `schema` on the gateway because it's multipart. |
| `GET /api/purchase-orders/invoice` | Invoice history list, `?limit` (clamped 1–100) `&offset` |
| `GET /api/purchase-orders/invoice/[id]` | One invoice: header, items, and the POs each line resolved to |
| `GET /api/purchase-orders/open-for-receive?mfg_id=` | Open POs for the per-line Reference PO picker. Entity-scope checked. |

## Files

| Path | Role |
|------|------|
| `lib/invoice-inward.ts` | The whole committed sequence and its compensation rules |
| `lib/nanonets.ts` | Extraction wire format |
| `lib/invoice-mapping.ts` | Fuzzy invoice → masters mapping |
| `lib/uniware.ts` | OAuth + PO create/fetch |
| `lib/po-receive.ts` | Shared receipt/tolerance/auto-close logic |
| `lib/queries/supplier-invoices.ts` | SQL for both invoice tables |
| `types/invoice.ts` | `ParsedInvoice`, `ParsedLineItem`, `OpenPoOption`, invoice-history row types |
| `prisma/add_supplier_invoices.sql`, `add_inward_po_type.sql`, `add_invoice_item_reference_po.sql`, `add_invoice_uniware_po_code.sql`, `add_po_uniware_code.sql`, `add_warehouse_entity_email_type.sql` | The migrations, in the order they were applied |
| `scripts/_check-invoice-mapping.ts`, `_check-inward-count.ts`, `_check-inward-sequence.ts`, `_check-inward-mail-summary.ts`, `_check-uniware-push.ts`, `_check-uniware-po-pdf.ts`, `_check-backdated-po.ts` | Verification scripts for each part of the flow |
