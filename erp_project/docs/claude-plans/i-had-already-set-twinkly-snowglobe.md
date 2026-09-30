# Dry-consumption sale order — reshape the existing API to the CSV's shape

## Context

Dry inventory is consumed out of a warehouse today by **hand-importing a CSV into
Uniware** (`import-1272240966820514_log.csv` is one such job). The gatepass route
meant to automate it is broken on Uniware's side (`nontraceable/addItem` returns
"No content to map to Object" at every facility), so the replacement already probed
in `check_uniware_apis/sale_order_check.py` is the sale-order route:
**create → invoice → forceDispatch → markDelivered**. Stock leaves at
`forceDispatch`, not at `markDelivered`.

That script has only ever run at `TEST_FACILITY`, which has zero stock and no dry
SKUs, so it has never completed end to end. Its constants are a single-SKU test
order. The CSV is the first ground truth: a real, accepted dry-consumption order
with the real facility, channel, customer, SKUs and quantities.

**The input will not be a CSV.** Another system will feed the order in. So nothing
here parses CSV — the CSV only fixes the *payload shape*. The script takes an order
spec (facility, codes, customer, channel, and a list of `(sku, qty)`), which is the
shape that other system will hand over.

Nothing exists for this flow in `erp_project` — no `saleOrder/create`, no
`markDelivered`, no `forceDispatch`. It stays Python until it is proven live; the
port to `lib/uniware/*` + an `/api/v1` route is a separate plan.

## The CSV, decoded

One sale order, six SKU lines, 7,600 units:

| CSV column | Value | Payload field |
|---|---|---|
| Sales Order Code* | `20260918022_1` | `saleOrder.code` |
| Display Sales Order Code | `DryConsumption\|18Sep2026\|98` | `saleOrder.displayOrderCode` |
| COD* | `0` | `cashOnDelivery: false` |
| Channel | `PM_B2C` | `saleOrder.channel` |
| Sale Order Item Code* | `Dry070`, `Dry003`, `Dry028_DT`, `HYPTBOX001`, `HYPTBOX003`, `Dry022` | `saleOrderItems[].code` — the SKU string itself, with qty > 1 |
| Shipping Method* | `STD` | `saleOrderItems[].shippingMethodCode` |
| Item SKU Code* | same as item code | `saleOrderItems[].itemSku` |
| Selling Price | `0.01` | `sellingPrice` / `totalPrice` |
| On Hold | `TRUE` | ❓ no known create-payload field |
| Quantity | 1800, 1800, 200, 1800, 1800, 200 | ❓ **the create payload has no quantity field** |
| Customer Code | `INWARD_RETURN_B2CUSE` | `saleOrder.customerCode` |
| Facility Code | `GGN_WAREHOUSE` | the `Facility:` header |
| Order Approval Status | `Unapproved` | ❓ `verificationRequired: true`? |

The CSV carries no address; the current `create_order` sends a dummy one.

## APIs and methods used

All `POST`, `Content-Type: application/json`, `Authorization: bearer <token>`,
`Facility: <facility>`. Uniware answers a *business* failure as **HTTP 200 with
`successful: false`**, so status and `successful` are both checked. The existing
`call(path, token, payload)` (`check_uniware_apis/sale_order_check.py:37`) prints
request and raw response and returns `(status, parsed)` — reuse it, don't rewrite.

| # | Endpoint | Body | Purpose | Proven |
|---|---|---|---|---|
| 0 | `/oauth/token?grant_type=password&client_id=…` | — | token, `get_token()` in `sale_order_gatepass.py:32` | yes |
| 1 | `/services/rest/v1/oms/saleorder/get` | `{"code":"20260918022_1"}` | **read back the order the CSV created** (lowercase path; camelCase 404s) | yes |
| 2 | `/services/rest/v1/inventory/inventorySnapshot/get` | `{"itemTypeSKUs":[…]}` or `{"updatedSinceInMinutes":1440}` | free stock = `inventory − openSale`; the no-filter form lists everything the facility stocks (1 day is the server's max window) | yes |
| 3 | `/services/rest/v1/oms/saleOrder/create` | `{"saleOrder":{…}}` | create the consumption order | shape unproven at a stocked facility |
| 4 | `/services/rest/v1/createInvoiceWithDetails`, fallback `/services/rest/v1/oms/shipment/createInvoiceAndLabel` | `{"shippingPackageCode":…}` | invoice | unproven |
| 5 | `/services/rest/v1/oms/shipment/forceDispatch` | `{"shippingPackageCode":…}` | **stock leaves here** | unproven |
| 6 | `/services/rest/v1/saleOrderItem/markDelivered` | `{"saleOrderCode":…,"saleOrderItemCodes":[…]}` | close the order | endpoint exists (`so_dispatch_discover.py`) |

Deliberately not used: `/purchase/gatepass/*` (broken `addItem`),
`/inventory/adjust/bulk` (moves stock with no document trail — left commented out in
`inventory_adjust_check.py`), `/export/job/*` (read-only, wrong direction).

## Phase 0 — read back `20260918022_1` (read-only, gates everything else)

`POST /oms/saleorder/get {"code":"20260918022_1"}` with `Facility: GGN_WAREHOUSE`.
Dump the raw JSON to the scratchpad (it could be ~7,600 items — do **not** print it
whole) and report:

1. **Quantity**: one item object per unit, or a quantity field on the item?
2. **Item codes**: what the import generated when the CSV said `Dry070` ×1800 —
   suffix scheme, or is `code` genuinely repeatable?
3. **On Hold / Unapproved**: which stored fields carry them, and their value *now*
   (if the order has since been approved and delivered, the whole chain is proven
   possible at `GGN_WAREHOUSE`).
4. **Address**: does `INWARD_RETURN_B2CUSE` carry one, or did the import invent one?
5. `channel`, `customerCode`, `sellingPrice`, `shippingMethodCode` as stored.

This answers empirically what the Uniware docs would otherwise have to. **If the
read-back contradicts anything below, the read-back wins.**

## Phase 1 — rehearse at TEST_FACILITY

`TEST_FACILITY` has no dry SKUs, so the rehearsal proves the *shape*, not the SKUs:

- Run the no-filter snapshot (`inventory_adjust_check.py --whats-here` already does
  exactly this) to find SKUs with free stock.
- Build a **two-line, small-quantity** order from them (e.g. 2 × sku A, 1 × sku B) —
  enough to prove multi-line and qty > 1 without burning sandbox stock.
- Try the CSV's `channel: PM_B2C` and `customerCode: INWARD_RETURN_B2CUSE` first;
  both are tenant-level, so they may work here. Fall back to `CUSTOM` /
  `TEST_CUSTOMER` and note which was needed.
- Run the full chain: create → get → invoice → forceDispatch → markDelivered, with a
  snapshot before and after to prove the stock actually moved.

## Phase 2 — reshape the script

Single file: `check_uniware_apis/sale_order_check.py`, edited in place.

- Replace `FACILITY` / `ITEM_SKU` / `ITEM_CODE` constants with one `ORDER` spec dict:
  `facility`, `code`, `display_code`, `customer_code`, `channel`, `shipping_method`,
  `selling_price`, and `items: [(sku, qty), …]`. This is the hand-off surface for
  the other system — no CSV reader, no file input.
- `build_items(order)` expands `(sku, qty)` per the Phase 0 finding: either a
  quantity field, or N objects with codes `{order_code}-{n}` unique across the whole
  order.
- `preflight` loops every SKU and refuses unless `inventory − openSale ≥ qty` for
  **all** of them — an unstocked SKU still creates a live order, so this stays before
  `create`.
- `describe` summarises by package and status counts instead of one line per item; it
  currently prints every item, which is unreadable at 7,600.
- `markDelivered` gets every item code, chunked if the request turns out to have a
  size limit (the read-back will hint at it).
- On-hold / approval fields go in **only** if Phase 0 shows them stored *and* the
  create payload has a matching field — an unknown body key 400s the whole call.

## Phase 3 — GGN_WAREHOUSE, gated

- Keep the existing flag discipline: nothing beyond create runs without `--dispatch`.
  Add a separate `--live` flag required for any facility other than `TEST_FACILITY`,
  so a stray run can never consume real stock.
- **Never reuse `20260918022_1`.** A reused code is either rejected or silently
  merged into the existing order.
- First live run: one SKU, small qty, not the full 7,600 — then the full order.

## Risks

- **`forceDispatch` is irreversible** and is where stock leaves. There is no probed
  undo. This is why Phase 1 rehearses at `TEST_FACILITY` and Phase 3 is flag-gated.
- **Unapproved may block invoicing.** If the CSV's "Unapproved" state is required by
  the desk's process and Uniware refuses to invoice an unapproved order, the chain
  needs an approve endpoint that has not been found yet — it becomes a Phase 0
  finding and a new question, not a guess.
- **Payload size.** 7,600 item objects in one request is untested. If it fails, the
  fallback is one order per SKU line (six orders), which the `ORDER` spec already
  allows without code changes.
- **IP allowlist.** If a call fails to connect rather than returning JSON, it is the
  Uniware IP allowlist — re-run from EC2 via SSM with `AWS_PROFILE=erp`.

## Verification

1. Phase 0 read-back returns the order and answers items 1–5 above.
2. `TEST_FACILITY`: `inventorySnapshot` before vs after shows `inventory` down by
   exactly the ordered quantity, and `saleorder/get` shows every item `DELIVERED`.
3. Every step printed raw: HTTP status, `successful`, and any `errors[]` with
   `code` / `fieldName` / `description`.
4. `GGN_WAREHOUSE`: same two checks on a small real order before the full one.

## Still unanswered (Phase 0 should answer them; docs welcome)

1. Does `saleOrder/create` take a quantity per item?
2. Which field puts an order On Hold, and which marks it Unapproved?
3. Can an unapproved order be invoiced and force-dispatched?
4. Does `INWARD_RETURN_B2CUSE` carry its own address?
5. Is `PM_B2C` accepted verbatim as `saleOrder.channel`?
