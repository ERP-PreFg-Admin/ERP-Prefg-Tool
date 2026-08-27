# PO Remarks — plan

**Goal:** the "Reason / Notes" typed when raising a PO stops being approval-only
metadata and becomes a column on `purchase_orders`, settable from the CSV bulk
upload too, and readable as a column on the FG PO Tracking table.

Today it goes nowhere durable: `app/api/v1/purchase-orders/route.ts:196` pushes
it as an `approval_items` row (`field_name = 'reason'`) and the `po_type ===
"normal"` branch drops it on the floor. Bulk CSV has no remarks concept at all.

---

## Decisions

| Question | Decision | Why |
|---|---|---|
| Column name | **`remarks`** | Every other remarks column in the schema is spelled that way (`prisma/add_remarks_columns.sql`, `history_masters_edits.remarks`, `details_warehouse_entity.remarks`). |
| Type | `VARCHAR(300) NULL` | Same as the nine columns in `add_remarks_columns.sql`. |
| API payload key | stays **`reason`** | `poCreateSchema`, both dialogs and the PUT route already use it. Renaming buys nothing and touches four more files. The route maps `reason → remarks`. |
| Keep the `reason` approval_item? | **Yes** | It is what the approvals card renders in the diff. Dropping it blanks the approver's view. Two writes of the same string, one for the record and one for the review. |
| Normal POs | now **store** it (still optional) | The field is already on the dialog for both types and silently discarded for `normal`. |
| Sortable? | **No** | Free text. Not added to `SAFE_SORT_COLS`. |

---

## 1 · Migration — `prisma/add_po_remarks.sql` (new)

```sql
-- purchase_orders.remarks — the "Reason / Notes" typed when a PO is raised.
--
-- Until now this lived only as an approval_items row (field_name = 'reason'),
-- which meant: normal POs discarded it entirely, and an impromptu PO's reason
-- was reachable only by finding its approval. It is a property of the order, so
-- it belongs on the order.
--
-- VARCHAR(300) NULL, matching every other `remarks` column in this schema
-- (see add_remarks_columns.sql).
--
-- MySQL 8.0: no ADD COLUMN IF NOT EXISTS — not re-runnable.
-- Run on BOTH schemas.

ALTER TABLE purchase_orders
  ADD COLUMN remarks VARCHAR(300) NULL AFTER destination;

-- Backfill: recover the reasons already captured on impromptu POs' approvals.
UPDATE purchase_orders po
  INNER JOIN approvals ap      ON ap.module = 'PO' AND ap.entity_id = po.id
  INNER JOIN approval_items ai ON ai.approval_id = ap.id
                             AND ai.field_name = 'reason'
   SET po.remarks = LEFT(ai.new_value, 300)
 WHERE po.remarks IS NULL
   AND ai.new_value IS NOT NULL
   AND ai.new_value <> '';
```

> Check the `approval_items` column names against `lib/queries/approvals.ts`
> before running — the backfill is the only part that can be wrong here, and it
> is safe to skip if you'd rather not touch history.

**`prisma/schema.prisma`** — add to `model purchase_orders`, after `destination`:

```prisma
  /// Free-text "Reason / Notes" captured when the PO was raised. Also settable
  /// from the bulk CSV. Mandatory only for impromptu POs (poCreateSchema).
  remarks        String?                 @db.VarChar(300)
```

---

## 2 · `lib/queries/purchase-orders.ts`

**`SELECT_COLS`** (line ~229) — add `po.remarks` next to `po.destination`:

```ts
    po.destination, po.remarks, ${DISPLAY_STATUS_EXPR} AS status, po.status AS raw_status,
```

**`insert`** (line 402, impromptu → draft) — one column, one `?`, placed before
the two `RECIPE_ID_FOR_LINE` params:

```ts
  insert: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination, remarks, recipe_id)
    VALUES (?, ?, ${SQL_TODAY_IST}, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ${RECIPE_ID_FOR_LINE})
  `,
```

**`insertNormal`** (line 412) — same shape:

```ts
  /**
   * Insert a normal PO directly as raised (no approval needed).
   * Parameters: [po_no, mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, remarks, mfg_id, sku_code]
   */
  insertNormal: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, unit_price, total_amount, expected_on, status, po_type, destination, remarks, recipe_id)
    VALUES (?, ?, ${SQL_TODAY_IST}, ?, ?, ?, ?, ?, 'raised', 'normal', ?, ?, ${RECIPE_ID_FOR_LINE})
  `,
```

**`insertBulkPo`** (line 721):

```ts
  /**
   * Insert a PO directly as 'raised' for the bulk CSV flow.
   * Parameters: [po_no, mfg_id, sku_code, qty, expected_on, destination, remarks, csv_source_key, mfg_id, sku_code]
   */
  insertBulkPo: `
    INSERT INTO purchase_orders
      (po_no, mfg_id, date, sku_code, qty, expected_on, status, po_type, destination, remarks, csv_source_key, recipe_id)
    VALUES (?, ?, ${SQL_TODAY_IST}, ?, ?, ?, 'raised', 'normal', ?, ?, ?, ${RECIPE_ID_FOR_LINE})
  `,
```

**`updateDraft`** (line 733) — the edit path re-collects the reason, so it must
land:

```ts
   * Parameters: [mfg_id, sku_code, qty, unit_price, total_amount, expected_on, destination, remarks, mfg_id, sku_code, id]
   */
  updateDraft: `
    UPDATE purchase_orders
    SET mfg_id = ?, sku_code = ?, qty = ?, unit_price = ?, total_amount = ?,
        expected_on = ?, destination = ?, remarks = ?, recipe_id = ${RECIPE_ID_FOR_LINE}
    WHERE id = ?
  `,
```

**`selectByPoNo`** (line 749) — the bulk importer diffs against it, so it has to
read the old value:

```ts
    SELECT id, po_no, status, expected_on, destination, remarks, sku_code, recipe_id,
```

**`updatePoStatusFields`** (line 763) — rename the doc comment to "4 fields":

```ts
  /**
   * Update only the fields the bulk CSV importer is allowed to edit on an
   * existing PO (status, expected_on, destination, remarks) — qty/rate/etc. are
   * deliberately out of reach here; use updateDraft for a full field edit.
   * Parameters: [status, expected_on, destination, remarks, id]
   */
  updatePoStatusFields: `
    UPDATE purchase_orders
    SET status = ?, expected_on = ?, destination = ?, remarks = ?
    WHERE id = ?
  `,
```

---

## 3 · `lib/validation/purchase-orders.ts`

Cap it to the column, one edit at line 27:

```ts
    reason: z.string().trim().max(300, "Remarks must be 300 characters or fewer.").optional().nullable(),
```

The existing `.refine(… po_type !== "impromptu" || reason)` stays — remarks are
still mandatory only for impromptu.

---

## 4 · `app/api/v1/purchase-orders/route.ts`

Both inserts gain one param. Line 148 (normal):

```ts
      const [poResult] = await conn.execute(purchaseOrdersSql.insertNormal, [
        po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, destination || null,
        reason?.trim() || null,
        Number(mfg_id), sku_code,
      ])
```

Line 175 (impromptu draft):

```ts
    const [poResult] = await conn.execute(purchaseOrdersSql.insert, [
      po_no, Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, po_type, destination || null,
      reason?.trim() || null,
      Number(mfg_id), sku_code,
    ])
```

Line 196's `diffItems.push(["reason", …])` is **unchanged** — the approver still
reads it in the diff.

---

## 5 · `app/api/v1/purchase-orders/[id]/route.ts` (PUT, re-edit)

Line 98:

```ts
    await conn.execute(purchaseOrdersSql.updateDraft, [
      Number(mfg_id), sku_code, Number(qty), unitPrice, totalAmount, expected_on || null, destination || null,
      reason?.trim() || null,
      Number(mfg_id), sku_code, poId,
    ])
```

---

## 6 · Bulk CSV

### `app/po-tracking/po-procurement/po-bulk-fields.ts`

Append after the `status` field:

```ts
  {
    key: "remarks", label: "Remarks", aliases: ["remarks"],
    placeholder: "Why this PO", sample: "",
    validate: (raw) => (raw.length <= 300 ? null : `must be 300 characters or fewer (got ${raw.length})`),
  },
```

Header matching needs nothing else: `parseS3Import` runs `normalizeHeader`, so
`"Remarks"` → `remarks` on the server exactly as it does in the browser preview.

Also update this file's row-semantics comment (line 27) — the update path now
writes four fields, not three.

### `lib/export-configs.ts` — `PO_PROCUREMENT_EXPORT_COLUMNS`

Add after `destination` (line 152), so download → edit → re-upload round-trips
the column instead of blanking it:

```ts
  { key: "remarks",       label: "Remarks",             type: "text"   },
```

### `lib/approvals/handlers/purchase-orders.ts` — `poBulkHandler`

**Update path** (after line 70), one raw + one diff line + one param:

```ts
          const rawDestination = row.destination?.trim() || null
          const rawRemarks     = row.remarks?.trim().slice(0, 300) || null
```

```ts
          if (rawDestination && rawDestination !== existing.destination) changes.push({ field: "destination", old: existing.destination ?? "", new: rawDestination })
          if (rawRemarks && rawRemarks !== existing.remarks) changes.push({ field: "remarks", old: existing.remarks ?? "", new: rawRemarks })
```

```ts
          await conn.execute(purchaseOrdersSql.updatePoStatusFields, [
            rawStatus ?? existing.status,
            rawExpectedOn ?? existing.expected_on,
            rawDestination ?? existing.destination,
            rawRemarks ?? existing.remarks,
            existing.id,
          ])
```

Same blank-never-clears semantics the other three fields already have, so a
re-uploaded export with an empty Remarks cell leaves the existing note alone.
Each change still writes its own `history_pos` row, so a remarks edit shows up
in the row's History dialog for free.

**Create path** (line 107 and 119):

```ts
          const destination = row.destination?.trim() || null
          const remarks     = row.remarks?.trim().slice(0, 300) || null
```

```ts
          const [poResult] = await conn.execute(purchaseOrdersSql.insertBulkPo, [
            newPoNo, mfg.id, skuCode, qty, expectedOn, destination, remarks, s3Key,
            mfg.id, skuCode,
          ])
```

Update the file's header comment (line 14) to say the update path covers
status/expected_on/destination/remarks.

---

## 7 · FG PO table column

### `po-types.ts`

On `PoRow`, next to `destination`:

```ts
  /** Free-text reason captured when the PO was raised, or set from the bulk
   *  CSV. Null on inward POs and on anything raised before the column existed. */
  remarks: string | null
```

On `EditData`, so re-opening the Impromptu dialog shows what was written:

```ts
  remarks: string | null
```

### `PoTable.tsx`

`BASE_COLUMN_COUNT` 13 → **14**, and update the comment above it to list
Remarks. Header cell, between Destination and Status (line 231):

```tsx
                  <TableHead>Destination</TableHead>
                  {/* FG only. On the inwarding desk every inward PO is raised by
                      an invoice, never by hand, so the column is always "—" —
                      the same reason Invoice No is inwarding-only above. */}
                  {!inwardingMode && <TableHead>Remarks</TableHead>}
                  <SortHead colKey="status"       {...sh}>Status</SortHead>
```

Because the column is conditional on `!inwardingMode`, the count line becomes:

```tsx
  const columnCount =
    BASE_COLUMN_COUNT + (selectable ? 1 : 0) + (inwardingMode ? 1 : 0)
    + (showUniwareCode ? 2 : 0) + (hasSplits ? 1 : 0)
```

(`inwardingMode` used to add 2 on a base of 13; it now adds its 2 and removes
Remarks, so net +1 on a base of 14.)

### `PoDataRow.tsx`

Matching cell after the Destination cell (line 285). Truncated with the full
text on hover — a 300-char note cannot have its own column width:

```tsx
      {!inwardingMode && (
        <TableCell className="text-xs text-muted-foreground">
          {r.remarks ? (
            <span className="block max-w-40 truncate" title={r.remarks}>{r.remarks}</span>
          ) : (
            "—"
          )}
        </TableCell>
      )}
```

### `PoProcurementClient.tsx` (line ~546)

Add to the `editData` object literal:

```tsx
          remarks:     editTarget.remarks,
```

### `ImpromptuPODialog.tsx` (line 61)

Prefill instead of blanking, so an edit doesn't silently wipe the note:

```tsx
        reason: editData.remarks ?? "",
```

---

## Out of scope (say the word and they go in)

- **PO PDF / manufacturer email.** `lib/pdf/po-document.tsx` doesn't print the
  remark. It reads like an internal note, not something the supplier needs.
- **Split children.** `insertSplit` won't copy the parent's remark, so a child
  shows "—". One extra column + param if you want it inherited.
- **Inward POs.** `insertInward` / `insertInwardReceived` leave it NULL; there is
  no human typing a reason on the inwarding desk.
- **Filtering / sorting by remarks.** Not added; free text on a 300-char column.

---

## Verification

```
npx tsc --noEmit --incremental false
npm run lint:changed
npm test
```

Then, against dev:
1. Add PO → **Normal**, type a remark → the row shows it (this is the case that
   used to discard it).
2. Add PO → **Impromptu** → approvals card still shows "reason" in the diff,
   and the row shows the remark before approval.
3. Edit a draft impromptu PO → the dialog opens with the old remark filled in,
   changing it persists.
4. Download CSV → the file has a Remarks column → edit one row's remark and one
   new-PO row → re-upload → approve → both land, and the update shows a
   `remarks` entry in that PO's History dialog.

## Files touched

14, all one-to-three lines each except the new migration:

`prisma/add_po_remarks.sql` (new) · `prisma/schema.prisma` ·
`lib/queries/purchase-orders.ts` · `lib/validation/purchase-orders.ts` ·
`app/api/v1/purchase-orders/route.ts` ·
`app/api/v1/purchase-orders/[id]/route.ts` ·
`lib/approvals/handlers/purchase-orders.ts` · `lib/export-configs.ts` ·
`app/po-tracking/po-procurement/po-bulk-fields.ts` · `po-types.ts` ·
`PoTable.tsx` · `PoDataRow.tsx` · `PoProcurementClient.tsx` ·
`ImpromptuPODialog.tsx`
