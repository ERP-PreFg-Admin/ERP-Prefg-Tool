# Traceability dataset contracts: v1

**Status (2026-10-27):** draft for sign-off.

- **Keys** are the CSV headers and the nightly feed's columns. They are **stable**: renaming or removing one means bumping to v2. Adding a column at the end is allowed within v1.
- **Excel** shows the label, and its Read-me sheet maps label → key.
- **Dates:** `YYYY-MM-DD` (IST); timestamps `YYYY-MM-DD HH:mm` (IST).
- **Quantities:** units. **Money:** ₹, pre-GST unless the label says incl. GST.
- **Empty cell** = not applicable or unknown, never 0.

## Shared building blocks
- **`batch_key`:** `UPPER(batch)` with spaces, `-`, `/`, `.` and `_` removed. Empty → `(no batch)`.
- **`ym`** (normalised month) from `Jun-2026`, `06/2026`, `06-2026`, `2026-06`, `2026-06-15`, `15/06/2026`, epoch ms → `2026-06`. Anything else → empty, plus an `*_unparseable` flag.
- **`master_po_no`:** a split child's `reference_po`, else its own `po_no` (non-inward only).
- **`entity_code`:**
  - invoice side: buyer GSTIN PAN → `master_entity`
  - PO side: SKU → brand → entity
- **`grn_synced_at`:** the latest `grn_uniware.synced_at` for the invoice. Empty = never synced.
- **`reverted`:** `invoice_mfg.reverted_at IS NOT NULL`. Reverted rows are included and flagged, and never counted in any total.

---

## T1: PO ↔ invoice line map
**One row per invoice line allocation** (`invoice_items_mfg.id`). This is the base of everything.

| Key | Label | Source / rule |
|---|---|---|
| line_id | Line ID | `invoice_items_mfg.id` |
| invoice_id | Invoice ID | `invoice_mfg.id` |
| invoice_no | Invoice No. | |
| invoice_date | Invoice Date | as printed (can be empty) |
| inwarded_at | Inwarded At | `invoice_mfg.created_at` |
| reverted | Reverted | yes/no |
| reverted_at | Reverted At | |
| mfg_code · mfg_name | Mfg Code · Manufacturer | |
| destination | Destination | `invoice_mfg.destination` |
| entity_code | Entity | buyer GSTIN PAN |
| uniware_po_code | Uniware PO | `invoice_mfg.uniware_po_code` |
| uniware_status | Uniware Status | |
| grn_synced_at | GRN Synced At | |
| line_no | Line No. (allocation) | position after FIFO split |
| printed_line_ref | Printed Line Ref | `invoice_no · sku · batch_key · expiry · rate`. Rows sharing it are one printed line |
| fifo_split | FIFO Split | yes when more than one row shares `printed_line_ref` |
| sku_code · sku_name | SKU · SKU Name | line SKU; name = Supply Name, else Uniware name |
| vendor_sku | Vendor SKU (as printed) | `parsed_sku_code` |
| brand | Brand | `master_skus.brand_id → master_brand.name` |
| hsn | HSN | |
| batch | Batch (as printed) | |
| batch_key | Batch Key | rule above |
| mfg_date · mfg_ym | Mfg Date · Mfg Month | raw · normalised |
| expiry · expiry_ym | Expiry · Expiry Month | raw · normalised |
| qty | Qty | |
| rate | Rate | |
| mrp · discount | MRP · Discount | |
| gst_pct | GST % | |
| taxable_value | Taxable Value | `amount` |
| gross_value | Value incl. GST | `amount × (1 + gst%/100)` |
| link_type | Link Type | created / received |
| po_id · po_no | PO ID · PO No. | `received_against_po_id` |
| master_po_no | Master PO | rule above |
| po_type | PO Type | |
| po_date | PO Date | |
| po_qty | PO Qty | ordered on that PO |
| po_rate | PO Rate | `unit_price` |
| rate_diff_pct | Rate Diff % | (rate − po_rate) / po_rate × 100; empty if the PO is unpriced or special |
| po_status | PO Status (display) | `DISPLAY_STATUS_EXPR` |
| sku_differs_from_po | SKU ≠ PO SKU | case-insensitive compare |
| inward_po_id · inward_po_no | Inward PO ID · Inward PO | `invoice_items_mfg.po_id` |
| inward_status | Inward PO Status | received / cancelled / reverted |
| un_qc_pass_qty · un_pending_qty | Uniware QC Pass · Pending | inward PO, SKU-level (repeats on every line of that SKU; **don't sum**) |

## T2: Batch ledger
**One row per (invoice, SKU, batch_key)**, full-outer-joined between live invoice lines and that invoice's GRN lines.

| Key | Label | Source / rule |
|---|---|---|
| invoice_id · invoice_no | | |
| mfg_code · mfg_name · destination | | |
| sku_code · sku_name | | SKU matched case-insensitively |
| batch_key | Batch Key | |
| invoice_batch | Batch on Invoice | raw spelling(s), joined with ` / ` |
| grn_batch | Batch on GRN | raw spelling(s) |
| batch_match | Batch Match | exact / loose / — (one side only) |
| billed_qty | Billed Qty | Σ invoice line qty |
| billed_value | Billed Value (pre-GST) | Σ taxable |
| grn_codes | GRN(s) | distinct, joined |
| grn_gross_qty | GRN Arrived | Σ `quantity` |
| grn_rejected_qty | GRN Rejected | Σ `rejected_qty` |
| grn_accepted_qty | GRN Accepted | gross − rejected |
| qty_gap | Billed − Arrived | |
| invoice_expiry_ym · grn_expiry_ym | Expiry (Invoice) · Expiry (GRN) | normalised |
| expiry_mismatch | Expiry Mismatch | yes when both parse and differ |
| grn_unmatched_po | GRN Line Not Linked | yes when any GRN line here has `po_id` NULL (case-drift or unraised SKU) |
| status | Status | see below |
| grn_synced_at | GRN Synced At | |

**`status`, first match wins:**
1. `grn_not_synced`: the invoice has no GRN rows at all.
2. `received_not_billed`: GRN only.
3. `billed_not_received`: invoice only.
4. `short_received`: arrived < billed by more than 2%.
5. `over_received`: arrived > billed by more than 2%.
6. `matched`: otherwise.

Rejections and expiry are separate flags, so a `matched` row can still carry `grn_rejected_qty > 0`.

## T3: PO receipt ledger
**One row per procurement PO** (non-inward, approved; masters and split children).

| Key | Label | Source / rule |
|---|---|---|
| po_id · po_no · master_po_no | | |
| is_split_child | Split Child | |
| po_type · po_date · expected_on · destination | | |
| mfg_code · mfg_name · sku_code · sku_name · brand | | |
| status | Status (display) | |
| qty | Ordered | |
| received_own | Received (this PO) | `received_qty` |
| received_incl_children | Received incl. Splits | `RECEIVED_TOTAL_EXPR`, masters only; empty on children |
| invoiced_live | Invoiced (live) | Σ lines `received_against_po_id = po`, not reverted |
| invoiced_reverted | Invoiced (reverted) | |
| received_without_invoice | Received without Invoice | received_own − invoiced_live (can be negative = data error) |
| history_delta | Σ Receipt History | Σ `history_pos` received_qty deltas |
| opening_balance | Opening Balance | received_own − history_delta |
| has_create_row | Has Create History | |
| invoice_count | Invoices | distinct live invoices |
| first_receipt_at · last_receipt_at | First / Last Receipt | from history |
| short_closed_qty | Short-closed Qty | gap if status is short_closed |
| open_qty | Open Qty | gap if status is open (PO-01 rule) |
| provenance | Provenance | `all_invoiced` · `partly_without_invoice` · `no_invoice` · `opening_balance` · `nothing_received` · `data_error` (negative without-invoice) |

**Must hold for every row:** `received_own = invoiced_live + received_without_invoice`, and `received_own = history_delta + opening_balance`.

## T4: Receipt events
**One row per `history_pos` row with `field_name = 'received_qty'`.**

| Key | Label | Source / rule |
|---|---|---|
| history_id | History ID | |
| po_id · po_no · master_po_no | | |
| changed_at | When | IST |
| changed_by | By | user name |
| old_qty · new_qty · delta | Before · After · Change | |
| source | Source | `invoice` · `invoice_revert` · `backfill` · `hand_fix` · `manual` · `unknown` |
| confidence | Confidence | `exact` (one-to-one match) · `heuristic` · `none` |
| invoice_id · invoice_no · line_id | Matched Invoice / Line | when source = invoice |
| seconds_after_invoice | Seconds after Invoice | match distance |

**Matching:** same PO, delta = line qty, and history time within −5…+120s of the invoice's `created_at`. One-to-one via `ROW_NUMBER` in both directions. Negative deltas with a `revert_reason` within 2s → `invoice_revert`. Unmatched → `backfill` if `changed_by = 10` in 2026-09, `hand_fix` if `changed_by = 2` on 2026-10-19, else `manual`.

## T5: GRN line dump
**One row per GRN line** (key `grn_code` + `line_no`).

| Key | Label | Source / rule |
|---|---|---|
| grn_code · grn_line_no | GRN · Line | |
| grn_status | GRN Status | `status_code` as Uniware sends it |
| grn_created_at | GRN Created | |
| facility_code | Facility | |
| vendor_invoice_no | Vendor Invoice (as keyed) | |
| invoice_id · invoice_no | Invoice | via `grn_uniware.invoice_id` |
| invoice_no_matches | Keyed Invoice = Invoice | normalised compare |
| uniware_po_code | Uniware PO | |
| sku_code · sku_name | SKU | |
| batch · batch_key | Batch · Batch Key | |
| expiry · expiry_ym · mfg_date · mfg_ym | | raw · normalised |
| gross_qty · rejected_qty · accepted_qty | Arrived · Rejected · Accepted | |
| inward_po_id · inward_po_no | Inward PO | `po_id` |
| linked | Linked to Inward PO | no = case-drift or unraised SKU |
| procurement_po_nos | Procurement PO(s) | distinct `received_against_po_id` of the invoice's lines for this SKU |
| billed_qty_for_sku | Billed for SKU (invoice) | context only; repeats per line, **don't sum** |
| grn_synced_at | Synced At | |

## T6: SKU summary
**One row per SKU × manufacturer**, with an optional month column (PO month).

| Key | Label | Rule |
|---|---|---|
| sku_code · sku_name · brand · mfg_code · mfg_name · month | | |
| po_count | POs | masters sent (PO-02 set) |
| ordered_qty | Ordered | |
| received_qty | Received (PO) | `RECEIVED_TOTAL_EXPR` |
| invoiced_qty | Invoiced (live) | lines against these POs (children rolled up) |
| received_without_invoice | Received without Invoice | |
| grn_gross_qty · grn_accepted_qty · grn_rejected_qty | GRN | GRN lines of those invoices for the SKU |
| open_qty | Open | PO-01 rule |
| closed_short_qty | Closed Short | PO-02 rule |
| invoice_count · batch_count | Invoices · Batches | distinct |
| fill_pct | Fill % | received / ordered |

**Must equal** PO-02 ordered and received for the same filter.

## T2 SKU-level fallback (2026-10-27, Ajay)
Prod showed that Uniware GRN lines carry **Uniware's own batch code** (`BA067849`), never the manufacturer's batch, and the stored payload has no vendor-batch field (expiry and mfg date are empty too). So:
- **When at least one batch pairs** for an invoice + SKU, rows stay at batch grain as before.
- **When no batch pairs at all,** the invoice + SKU becomes one row:
  - `batch_key = "(sku level)"` and `batch_match = "sku_level"`;
  - `invoice_batch` and `grn_batch` list both sides' codes;
  - the status comes from billed vs arrived qty.
- **Effect on prod:** the batch-problem count dropped from 1,316 false alarms to 27 real ones.
- **Contract:** `sku_level` is a new value of an existing column (allowed within v1).

## v1 additions (2026-10-27, appended at the end of each dataset)

| Dataset | Key | Rule |
|---|---|---|
| T1 | shelf_life_months_at_receipt | expiry_ym − inwarded month (whole months) |
| T1 | short_dated | shelf life under 12 months (`SHORT_DATED_MONTHS`) |
| T1 | days_po_to_invoice | PO date → inwarded day (IST) |
| T1 | days_invoice_to_grn | inwarded day → the invoice's first GRN |
| T2 | shelf_life_months_at_receipt · short_dated | earliest invoice expiry (else GRN expiry) vs inwarded month |
| T2 | days_invoice_to_grn | inwarded day → first GRN for that batch |
| T2 | rejection_pct | GRN rejected / arrived × 100 |
| T5 | shelf_life_months_at_receipt · short_dated | expiry_ym vs GRN created month |
| T6 | rejection_pct | GRN rejected / arrived × 100 (blank by month) |

## Read-me sheet (every workbook)
- Run time and filters.
- Contract version, plus the columns per sheet as key → label → rule.
- The batch rule.
- The GRN freshness range.
- Known data caveats:
  - the Sept line loss;
  - the 123 imported POs;
  - unfixed swaps MPO-INW-202610-166/167;
  - history before 2026-07-25 missing;
  - GRN case-drift.
