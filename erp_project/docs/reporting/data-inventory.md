# Reporting — data inventory

**Status (2026-10-26):** discovery, read-only. Built from code and migrations only, with no DB queries. Every prod figure is quoted from earlier docs and memory notes, not measured. Paths are relative to `erp_project/`. Real table names are in `lib/queries/*.ts`; `prisma/schema.prisma` still carries the pre-rename names (see CLAUDE.md).

## Time bases (read before any date filter)

| Column | Meaning |
|---|---|
| `purchase_orders.date` | **IST DATE** (`lib/queries/daily-digest.ts:4-6`) |
| `email_sent_at`, `invoice_mfg.created_at`, `reverted_at`, `grn_uniware.synced_at` | UTC DATETIME (pool timezone `+00:00`, `lib/db.ts`) |
| `invoice_mfg.invoice_date` | The supplier's printed date. Can be NULL |
| `approvals.raised_on` / `approved_on` | TIMESTAMP. `approved_on` is stamped on reject too |
| `history_pos.changed_on` | DB default. Prod DB-side timestamps are noted as ~5h30 off; **verify before relying on hour-level precision** |

Reports filter dates as IST days, using `istDayWindowUtc` for UTC columns.

## 1. Purchase orders

| Table | Grain | Key columns | Written by | History |
|---|---|---|---|---|
| `purchase_orders` | One PO line (one SKU). **Split children and inward POs are rows too** | `po_no` (unique), `mfg_id`, `sku_code` (joins `master_skus.sku_code`, no FK), `recipe_id`, `qty` (immutable after raise), `unit_price`, `amount_pre_gst`, `total_amount`, `received_qty`, `expected_on`, `destination` (= `master_warehouse.name`, text), `reference_po`, `po_type`, `status`, `email_sent_at`, `uniware_po_code`, `un_*` | Raise `app/api/v1/purchase-orders/route.ts`; bulk handler; inward `lib/invoice/invoice-inward.ts:224-234`; split `[id]/split`; receipts `lib/po/po-receive.ts`; revert; Uniware sync | **No created/updated columns.** "Last updated" is derived (`lastPoUpdate`) |
| `history_pos` | One field change, or one `create` row | `po_id`, `action_type` ENUM(create, update), `field_name`, `old_value`, `new_value`, `changed_by`, `changed_on` | cancel/close (**from 2026-10-26 only**), split, receive, inward create, revert, draft edit, bulk | Partial: normal/impromptu creation writes no row; no source column (inferred, `purchase-orders.ts:899-955`) |
| `approvals` + `approval_items` | One submission + its changed fields | `module` (PO, PO_EDIT, PO_BULK, …), `entity_id`, `status`, `raised_on`, `approved_on` | `lib/queries/approvals.ts` | **No index on (module, entity_id)** |

- `po_type` ENUM: normal, impromptu, inward, npd, tech_transfer, cpr. The default is **impromptu**, so SQL-inserted rows can be mistyped.
- `status` ENUM: draft, raised, punched, short_closed, partially_received, received, cancelled, rejected, reverted.
  - `partially_received` is **derived** (`EFFECTIVE_STATUS_EXPR`, `purchase-orders.ts:72`).
  - "Draft" as displayed = stored `raised` with no `email_sent_at` (`DISPLAY_STATUS_EXPR`, `:125`).
  - Stored `draft` / `rejected` are hidden by `APPROVED_ONLY` (`:152`).

**Building blocks to reuse** (all in `lib/queries/purchase-orders.ts`, currently module-private, so they need exporting):
- `IS_SPLIT_CHILD` / `MASTERS_ONLY` (`:27`, `:149`)
- `CHILD_AGG_JOIN` (`:32`): live children per master, cancelled excluded
- `RECEIVED_TOTAL_EXPR` (`:52`): master's own receipts + children's
- `EFFECTIVE_STATUS_EXPR`, `DISPLAY_STATUS_EXPR`, `APPROVED_ONLY`
- `summaryStats` (`:397`): the existing open/committed/received/overdue formulas

## 2. Inwarding, invoices, GRN

| Table | Grain | Key columns | Notes |
|---|---|---|---|
| `invoice_mfg` | One supplier invoice | `mfg_id`, `invoice_no`, `live_invoice_no` (NULL once reverted; unique with mfg), `invoice_date`, `destination`, `buyer_gstin`, `invoice_total`, `uniware_po_code`, `uniware_status`, `uniware_synced_at`, `uniware_grn_count`, `reverted_at`, `created_at` | Revert is soft; never deleted (5 hard-deleted before soft revert existed) |
| `invoice_items_mfg` | One invoice line | `invoice_id`, `po_id` (inward PO it raised), `received_against_po_id` (procurement PO it settled, **indexed** `idx_sii_received_against`), `link_type`, `sku_code`, `batch`, `qty`, `rate`, `gst_percent`, `amount` (taxable), `total_amount` | No index on `sku_code` |
| `invoice_leg_verification` | (invoice, leg ∈ po/pod/inv) | `verified_by`, `verified_at` | Overwritten in place |
| `invoice_payment` | One per invoice | `status` (pending → completed), `utr` | Overwritten in place. Derived states are in `lib/invoice/three-way.ts` |
| `grn_uniware` / `grn_items_uniware` | One GRN / one GRN line | `grn_code`, `uniware_po_code`, `invoice_id`, `facility_code`, `grn_created_at`; line `sku_code`, `po_id`, `quantity` (**gross**), `rejected_qty` | **Refreshed only by a manual button** (no cron). Covers only invoice-mirrored POs |

Accepted GRN qty = `quantity − rejected_qty`. Three-way match tolerance is 2% (`MATCH_TOLERANCE`, `three-way.ts:13`), which is different from the PO auto-close tolerance `poTolerance` (10%, max 100).

## 3. Inventory — no data exists

| Searched | Result |
|---|---|
| `app/inventory` | Absent. `/inventory` is "Planned" in `lib/pages.ts` |
| stock / snapshot / inventory / blocked / damaged across lib, app, prisma, scripts | Only outbound payload fields and gatepass party codes |
| Uniware endpoints used (`lib/uniware/endpoints.ts`) | No inventory or snapshot call |
| Vendor Item Master sync, gatepass | Both state "nothing is kept" |
| Cron (`lib/cron/jobs.ts`) | Only `daily-digest` and `low-open-po` |
| Post-FG | Separate app and infrastructure, no tables in this DB |

The nearest data is GRN receipts and the overwritten `un_pending_qty` / `un_qc_pass_qty` on inward POs. **No on-hand balance, no history.**

## 4. Masters and costing

| Table | Grain | Notes |
|---|---|---|
| `master_skus` | One SKU | `brand_id` is the access boundary, while free-text `brand` groups variant families. `gst` is known-dirty (17 at 0%, soap/shampoo at 5%). `supply_name` filled for 256 of 320 on prod |
| `master_rm` / `master_pm` | One material | No rate history on the master itself |
| `cost_master_{rm,pm}_mfg` | (material, mfg), several status rows | Filter `status='active'`. RM assumed per kg (the `uom` column is ignored by costing) |
| `cost_master_{rm,pm}_ven` | (material, vendor, MOQ slab) | One row per slab |
| `history_cost_mfg` / `_ven` | One row per overwritten rate | Starts at a rate's first overwrite; no UOM |
| `master_recipe` / `details_recipe` | Recipe version / line | `mtrl_type` rm/pm/sku |
| `bom_misc` | (mfg, sku, type), one live row | Must filter status (archived rows share the table). `cost` mixes ₹ and % |
| `master_mfgs` / `details_mfg` | Mfg | `details_mfg` not unique on `mfg_id`. **Mfg ids differ dev vs prod from 16 up; key reports on `code`** |
| `master_warehouse` / `details_warehouse_entity` | Site / facility (site × entity) | Joining without an entity filter doubles the rows |
| `un_code_mfg_sku_wh_map` | (facility, mfg, sku) | `sku_id IS NULL` = the vendor-code row; exclude it from counts |

Costing is never stored. It is computed on read (`lib/costing/agreed-rates.ts`, `lib/costing/final-costing.ts`). `master_cost_*` / `details_cost_*` are dead tables.

## 5. Audit

- `activity_log`: method/path/status per non-GET request; no entity, no payload.
- `history_masters_edits`: submission-level only; field diffs are in `approval_items`.
- `session_history`, `nanonets_usage` (daily counter).

## Join paths

**Safe (1:1):**
- `po.sku_code → master_skus`, then `→ master_brand → master_entity`
- `po.mfg_id → master_mfgs`
- `po.destination → master_warehouse.name → details_warehouse_entity` (on warehouse_id **and** entity_id, active)
- `invoice_items_mfg → invoice_mfg`
- `grn_items_uniware → grn_uniware → invoice_mfg`

**Multiplying — must be handled:**

| Trap | Handling |
|---|---|
| Invoice receipt stored on the referenced PO **and** as an inward PO | Ordered/open from non-inward masters; receipts from `RECEIVED_TOTAL_EXPR` or invoice lines, never both |
| Split master + children both carry qty and value | `MASTERS_ONLY` + `CHILD_AGG_JOIN` |
| One procurement PO settled by up to ~20 invoice lines; lines × GRN lines | Aggregate in scalar subqueries, as `INVOICE_LIST_BODY` does |
| `invoice_mfg.uniware_po_code` not unique | Scalar subquery |
| `history_pos`, `approvals` have many rows per entity | Latest via `ORDER BY … LIMIT 1` |
| `details_mfg` per mfg | `LIMIT 1` subquery, never an INNER JOIN |
| Recipe versions | `selectMiscCostsByMfg` fans out to every version; `agreedRatesByMfg` keys by SKU (a second live recipe overwrites the first) |

**Entity attribution differs:** PO → SKU → brand → entity; invoice → buyer GSTIN PAN → entity. A report states which one it uses.

## Feasibility matrix (Phase 1 metrics)

| Metric | Source | Filter | Aggregation | Limitation |
|---|---|---|---|---|
| Open qty | `purchase_orders` masters + `CHILD_AGG_JOIN` | non-inward, `APPROVED_ONLY`, display status ∈ raised/punched/partially_received | `GREATEST(qty − RECEIVED_TOTAL_EXPR, 0)` | Auto-close tolerance can leave up to min(10%, 100) short as `received` |
| Open value pre-GST | as above × `unit_price` | priced class only | `open_qty × unit_price` | 455 unpriced POs; special types are 0 by design |
| Open value incl. GST | × (1 + `master_skus.gst`/100) | priced class | as above | GST master errors |
| Overdue | `expected_on < today (IST)` | open | count / qty | `expected_on` nullable |
| Age (days) | `today (IST) − po.date` | open | per PO; buckets | — |
| Ordered vs received by mfg/month | masters `qty`; `RECEIVED_TOTAL_EXPR` | non-inward, not cancelled/reverted | SUM by mfg × `DATE_FORMAT(po.date)` | — |
| Lead time PO → receipt | `po.date` → first `invoice_mfg.created_at` via `received_against_po_id` | non-reverted invoices | median / p90 days | Only since invoice inwarding went live; earlier receipts (bulk/manual) have no date except `history_pos` |
| Invoice total vs lines | `invoice_total` vs SUM(line `total_amount`) | `reverted_at IS NULL` | difference per invoice | Sept line loss (16/52 invoices) |
| Billed vs GRN accepted | line qty vs GRN `quantity − rejected_qty` | GRN synced | per invoice | Stale if the sync button wasn't pressed |
| Invoice rate vs PO rate | line `rate` vs PO `unit_price` | `received_against_po_id` not null, priced | % diff per line | Inward lines with no reference PO are excluded |
| Data-quality counts | various (see DQ-01) | — | counts + row lists | — |
