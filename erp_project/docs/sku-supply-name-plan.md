# SKU Master — Supply Name + "Uniware Name" relabel

**Status (2026-10-01):** steps 1–4 built. DDL is applied to **dev only** (`prisma/add_master_skus_supply_name.sql`). Step 5 is deferred. Step 6 needed no change: the approval card already renders `supply_name` as "Supply Name". **Prod DDL is pending its own go-ahead and must land before deploy.**

## Decisions (2026-10-01)

1. CSV: **A**, one approval per file (`SKU_NAME_BULK`).
2. Uniware Name stays **read-only**. Only Supply Name is editable.
3. **Supply Name is the name used for all PO raising.** This adds step 5 below.
4. `supply_name VARCHAR(500)`.
5. **Scope for now: master only** (steps 1–4 and 6). Step 5, PO raising, is **deferred** until how Supply Name is used is decided.

## What is being asked

1. A new **Supply Name** column on the SKU master.
2. The existing **Name** column shown as **Uniware Name**.
3. Supply Name editable from the SKU edit dialog, through the `SKU` approval flow.
4. A CSV upload that fills Supply Name across many SKUs, also through approvals.

## Key facts that shape the plan

- `master_skus.name` is **overwritten by the DWH sync** (`scripts/sync-skus-from-dwh.ts`, `ON DUPLICATE KEY UPDATE name = …`). That is why it really is the Uniware name. It also means:
  - Renaming is **label-only**. The column stays `name`. About 30 files read it as `sku_name` (PO PDFs, mails, recipes, costing), and none of them change.
  - `supply_name` must be a **separate column that the sync never touches**, or it gets wiped every night.
- The `SKU` approval handler applies only columns on its allowlist (`SKU_TARGET.columns`). If `supply_name` is missing from that list, an approved edit is **silently dropped**. That's the main correctness risk.
- The SKU master has **no CSV upload UI** today, and there is no `SKU_BULK` approval module. The route's old `bulk` actions insert directly, without approval. So the CSV is new work, not an extension of something that already exists.

## Sequence and gates

| # | Step | Gate before moving on |
|---|------|------------------------|
| 1 | **DDL on dev only**: `ALTER TABLE master_skus ADD COLUMN supply_name VARCHAR(500) NULL AFTER name`, as `prisma/alter_master_skus_supply_name.sql`, plus the schema.prisma line | Column exists on `mcaff_prefg_dev`. **Stop.** Prod DDL needs its own go-ahead |
| 2 | **Read path**: add to `SKU_COLUMNS`, the `Sku` type, the table column, the export columns. Relabel Name → Uniware Name in the table, the variants popup and the export header | Page renders on dev with an empty Supply Name column |
| 3 | **Single edit**: Supply Name field in `EditSkuDialog`, the Zod `skuUpdateSchema`, the route's `proposed` diff and `SKU_TARGET.columns` | Edit → approval card shows `supply_name` old → new → approve → value is in the DB. **This round trip is the test for the allowlist risk** |
| 4 | **CSV upload** (design below) | A dev file with good, unknown-code and in-review rows previews correctly, and approving it writes only the good rows |
| 5 | **PO raising uses Supply Name** (detail below) | Preview a PO PDF and a selection mail on dev: one SKU with a Supply Name shows it, one without shows the Uniware Name |
| 6 | Approval card label map, so `name` shows as "Uniware Name" and `supply_name` as "Supply Name" (today it just shows the field name with spaces) | Visual check |
| 7 | Prod DDL → deploy | Your explicit go-ahead |

The DDL must reach an environment **before** the code that SELECTs the column. `SKU_COLUMNS` feeds every SKU read, so deploying the code first breaks the whole SKU master.

## Step 5 — PO raising on Supply Name

The PO never stores the name. Every PDF and mail joins `master_skus` live. So the change is a column swap in the queries, with **nothing to backfill**, and it also applies to already-raised POs the next time their PDF or mail is generated. **Uniware gets only the SKU code**, so its payload doesn't change.

Swap: `sk.name AS sku_name` → `COALESCE(NULLIF(TRIM(sk.supply_name), ''), sk.name) AS sku_name`. A SKU nobody has filled in yet keeps printing its Uniware name rather than a blank.

| Path | Query (`lib/queries/purchase-orders.ts` unless noted) |
|---|---|
| PO PDF (normal + split) | `selectForEmail` |
| Selection mail table + XLSX, split mail | `buildSelectByIds` |
| "Remaining open POs" in the mail | `ongoingByMfg` |
| Add PO picker | `manufacturing.ts` `selectOrderableBomsForMfg` |
| Impromptu PO picker | `skuOptions`, as an **added** column. Inwarding's `matchSku` fuzzy-matches invoice text against the existing `name` and keeps it |
| PO tracking table + export | `SELECT_COLS`, so what users see matches what the manufacturer received |
| 8am low-open-PO report | `lowOpenByMfg`, the select **and** its `GROUP BY` |
| PO search box | `FULL_WHERE` / `SUMMARY_WHERE` also match `supply_name`. That adds a placeholder, so `buildFilterParams` and `buildStatusCountParams` grow by one |

Not changed: the inward warehouse mail (it prints the text parsed off the manufacturer's invoice), Uniware payloads, gatepass, and the manufacturing/costing screens.

## CSV design (decided: A)

Template columns: `sku_code, supply_name, remarks`. **Edit-only**: it never creates SKUs and never touches any other field. Rows are matched by exact `sku_code`. Unknown codes, SKUs already `in_review`, and rows with no change are listed as skipped in the preview.

Two ways to route it through approvals:

| | **A. One approval per file (recommended)** | B. One approval per row |
|---|---|---|
| Shape | New `SKU_NAME_BULK` module. The file is staged in S3 the way the other `*_BULK` modules are, and rows are applied on approval | Each row becomes its own normal `SKU` approval (the vendor/mfg bulk-edit pattern) |
| Approver | Reviews 1 card for 500 SKUs | Reviews 500 cards |
| Locking | SKUs are **not** set to `in_review` while the file waits. On approval, a row whose SKU went into review in the meantime is skipped and logged | Each SKU is locked straight away |
| Diff shown | Approval card previews the file's old → new rows | Normal per-field diff |

Supply Name is a bulk backfill (one field across hundreds of SKUs), so A is the shape that suits it. B is closer to how vendor edits work, but it floods the queue.

Supply Name is also added to the SKU master's fuzzy search fields.

## Risks

- **The PO search placeholder count drifts** → the PO list 500s, or filters bind to the wrong `?`. Both param builders change in the same commit; covered by searching the PO list on dev.
- **A long Supply Name in the PDF description cell** (up to 500 chars) wraps across lines. Checked during the step 5 preview.

- **The allowlist is missed** → edits are approved but never saved. Covered by the step-3 round trip.
- **A sync that rewrites the whole row** would wipe `supply_name`. Checked: it upserts named columns only. Re-check if the sync script changes.
- **Code deployed before prod DDL** → the whole SKU master errors. Covered by step 6 ordering.
