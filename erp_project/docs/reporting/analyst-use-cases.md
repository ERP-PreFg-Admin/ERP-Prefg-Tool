# Reporting — analyst use cases

**Status (2026-10-26):** proposed. The audience is **everyone** (Ajay), so each report is scoped to the viewer's own brands, manufacturers and warehouses, and is visible only to people who can open the report's source page.

The decisions behind the definitions below:
- **Value:** pre-GST and GST-inclusive shown side by side. **Totals and sorting use pre-GST.** Unpriced and special POs are counted separately, never as ₹0.
- **Open:** approved, mailed, effective status raised / punched / partially_received, open qty > 0, non-inward, masters only. Same as the FG PO Tracking "Open" tab.

## Phase 1 — Essential

### PO-01 Open PO book
- **Question:** What does each manufacturer still owe us, and how late is it?
- **Who and why:** Procurement, daily. Decides who to chase, whether to raise more, and whether to short-close.
- **Source:** `purchase_orders` masters (non-inward, `APPROVED_ONLY`) + `CHILD_AGG_JOIN`, `master_skus`, `master_mfgs`. Sufficient.
- **Metrics:**
  - open qty = `GREATEST(qty − RECEIVED_TOTAL_EXPR, 0)`
  - open value pre-GST = open qty × `unit_price`
  - incl. GST = × (1 + sku gst/100)
  - age = IST today − `po.date`
  - overdue = `expected_on` < IST today
  - price class ∈ priced / unpriced / special
- **Dimensions:** manufacturer, SKU (supply name), brand, destination, PO type, age bucket (0–30, 31–60, 61–90, 90+).
- **Filters:** mfg, brand, destination, SKU search, PO type, overdue only, age bucket, PO date range.
- **Output:** one table row per open master PO. Header totals: open qty, open value pre-GST, overdue POs, unpriced count.
- **Drill-down:** PO → its split children and the existing PO History dialog.
- **Action:** chase overdue lines, short-close stale ones, raise against low open qty.
- **Priority / complexity:** P0 / Low. It reuses `summaryStats` math.

### PO-02 Manufacturer fill rate
- **Question:** Did each manufacturer deliver what we ordered, and how fast?
- **Who and why:** Procurement and management, monthly. Supplier performance, and where to place the next order.
- **Source:**
  - masters by `DATE_FORMAT(po.date,'%Y-%m')`: ordered qty and `RECEIVED_TOTAL_EXPR`
  - lead time: `po.date` → the first non-reverted `invoice_mfg.created_at` via `invoice_items_mfg.received_against_po_id`
- **Metrics:**
  - fill % = received / ordered, excluding cancelled and reverted
  - short-closed qty shown on its own
  - median and p90 lead days
  - on-time % = received by `expected_on`
- **Filters:** mfg, brand, month range.
- **Output:** a mfg × month table. **No chart in Phase 1.**
- **Drill-down:** the month cell → the POs behind it.
- **Data warning:** lead time exists only for receipts booked through invoices (since invoice inwarding went live). Older receipts show fill but no lead time. The report says so on screen.
- **Priority / complexity:** P1 / Medium.

### INV-01 Invoice reconciliation exceptions
- **Question:** Which invoices disagree with their own total, the GRN, or the PO?
- **Who and why:** Inwarding and finance, daily. Fix before paying.
- **Source:** `INVOICE_LIST_BODY` measures (`lib/queries/supplier-invoices.ts:103-221`), `lib/invoice/three-way.ts`, `reverted_at IS NULL`, brand filtered **per line**.
- **Exception types (one row each):**
  - invoice total ≠ sum of lines (more than ₹1)
  - three-way leg in `variance` (2% tolerance)
  - leg `missing` older than N days
  - GRN never synced
  - GRN rejected qty > 0
- **Filters:** mfg, destination, invoice date range, exception type, payment status.
- **Drill-down:** the invoice → the existing invoice detail.
- **Data warning:** GRN data is only as fresh as the last sync button. The page shows the oldest `uniware_synced_at` in the result.
- **Priority / complexity:** P0 / Medium.

### INV-02 Invoice rate vs PO rate
- **Question:** Are we being billed at the agreed rate?
- **Source:** `invoice_items_mfg.rate` vs `purchase_orders.unit_price` via `received_against_po_id`. Unpriced and special POs are excluded and counted.
- **Metrics:** diff % per line; value at risk = (rate − PO rate) × qty.
- **Filters:** mfg, SKU, date range, |diff| ≥ X%.
- **Priority / complexity:** P0 / Low. It ships as a tab of INV-01.

### DQ-01 Data-quality exceptions
- **Question:** What data is broken, and where do I fix it?
- **Who:** the people who own each master; ops leads weekly.
- **Checks** (each a count plus a row list with a link to the fixing screen):
  1. Priced-type POs with no `unit_price` (unpriced)
  2. Normal POs with `amount_pre_gst` NULL (the pending GST backfill)
  3. `total_amount = 0` while `amount_pre_gst > 0` (the flip health check)
  4. Active SKUs with GST 0 or NULL
  5. Active SKUs with no supply name
  6. Live mfg × facility pairs with SKUs mapped but no vendor-code row
  7. Non-reverted invoices never synced to Uniware
  8. Open POs with no destination, or a destination that isn't in `master_warehouse`
  9. `invoice_total` vs lines mismatch (shared with INV-01)
- **Priority / complexity:** P0 / Low.

## Phase 2 — Advanced
- **CST-01 Rate change log:** RM/PM rate moves per material, vendor and mfg from `history_cost_*`. History starts at each rate's first overwrite and has no UOM.
- **CST-02 SKU cost across manufacturers:** agreed final costing for one SKU at every mfg (`agreedRatesByMfg` + `final-costing.ts`). An as-of date moves the rates only.
- **PO-03 Monthly PO trend:** volume and pre-GST value by month × brand × mfg. The first candidate for a chart, if one is wanted.
- **INV-03 Payment ageing:** invoices by payment state and age.

## Phase 3 — Future (needs new data)
- **Stock by SKU × facility, zero-stock, blocked/damaged, variance, ageing:** needs a scheduled Uniware inventory snapshot ingest into a new table, plus the history it would build up from that day on. Nothing exists today.
- **Marketplace PO / GRN / RTO reconciliation:** no marketplace data in this DB.
- **Lead time for pre-invoice receipts:** needs a create row in `history_pos` for every PO (currently missing for normal and impromptu POs).
