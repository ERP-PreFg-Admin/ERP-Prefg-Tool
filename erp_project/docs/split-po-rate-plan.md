# Split POs carry the parent's rate

## Context

`insertSplit` (`lib/queries/purchase-orders.ts:723-726`) copies qty, destination,
expected date and recipe from the parent, but **no `unit_price` and no
`total_amount`**. Every split child is born unpriced, even though the split route
already reads both from the parent (`selectForSplit`, `:675-679`).

Consequences today:
- the PO table shows `—` for Rate and Amount on every child;
- the invoice three-way match flags a child as **unpriced**
  (`lib/invoice/three-way.ts:364`), so a delivery booked against a split cannot be
  rate-checked;
- the child's PDF prints `—` prices.

State, 2026-10-06: prod has **8** split children, all unpriced, all open, mailed,
and with a stored PDF. Only **2** have a priced parent. Dev: 2 and 2.

## Sequencing and gates

1. **Price new splits** — route + query. Gate: split a priced PO on dev; child
   rate = parent rate, child amount = rate × child qty.
2. **Stop the open-value double count** in the same change (see below). Gate:
   MFG Overview open value for that manufacturer unchanged by the split.
3. Deploy. **No DDL.**
4. **Backfill the 2 existing prod children — separate go-ahead** (prod data write).

## Design

### 1. The rate

In the split route (`app/api/v1/purchase-orders/[id]/split/route.ts`, the
`insertSplit` call at `:92`):

Every child takes **the parent PO's `unit_price`** (read by `selectForSplit`),
whichever manufacturer it goes to — the parent's PO is the single source of the
rate, not a fresh costing lookup.

`total_amount = round(unit_price × child qty, 2)`, with `unit_price` already in
paise — the same rule as `lib/po/po-rate.ts:71-72`, so a manufacturer multiplying
the printed rate by the printed qty gets the printed amount. A parent with no
price gives a child with no price (NULL, never 0).

`insertSplit` gains `unit_price, total_amount` in its column list; keep
`recipe_id`'s resolver params at the tail.

### 2. Open value must not count a split twice

The parent's `qty` (and so its `total_amount`) no longer shrinks when it is split
— the split route deliberately stopped doing that. `overviewByMfg.open_value`
(`lib/queries/manufacturing.ts:241`) sums `total_amount` over **every** open PO,
parents and children alike. Children contribute ₹0 today only because they are
unpriced; pricing them would double the split quantity's value.

Fix: exclude split children from that sum —
`AND NOT (reference_po IS NOT NULL AND COALESCE(po_type,'') <> 'inward')`,
the same predicate as `IS_SPLIT_CHILD`. The parent's full value already covers
them, so the figure is **exactly today's**. `open_pos` (the count) is left as is.

Checked: that is the only `SUM(total_amount)` over `purchase_orders` in
`lib/queries/`.

### 3. Backfill (optional, own go-ahead)

For the 2 prod children whose parent is priced:
`unit_price = parent.unit_price`, `total_amount = round(unit_price × qty, 2)`.
Their **stored PDFs keep showing `—`** — per the earlier decision to leave saved
PDFs alone, a re-send reuses them. The table, Excel export and three-way match
pick up the price immediately. The other 6 have unpriced parents: nothing to copy.

## Not doing

- Shrinking the parent's qty/value on split — deliberately removed earlier.
- Re-rating children when the parent's rate changes later. A child is its own PO
  from the moment it is created.

## Risks

1. **Splits of NPD POs** (`docs/claude-plans/plan-out-a-way-snoopy-lantern.md`)
   stay unpriced, because the NPD parent is unpriced — consistent with that plan.
2. **Other value roll-ups** outside `lib/queries/` (e.g. a dashboard summing in
   JS) would double count the same way. Grep `total_amount` in `lib/services/`
   and `app/` before shipping.
3. **Different-manufacturer splits** (API only — `SplitPODialog` always sends the
   parent's) also carry the parent's rate, which was agreed at the parent's
   manufacturer. Chosen deliberately: the parent PO is the source of the price.

## Verification

- `npm run test:db` — new test under `withRollback`: split a priced PO into two
  children → each child `unit_price` = parent's, `total_amount` = rate × qty; an
  unpriced parent → children NULL; `overviewByMfg.open_value` identical before and
  after the split.
- `npm run lint:changed`, `npx tsc --noEmit --incremental false`.
- Manual on dev: split a priced PO → table shows the rate and amount on each child
  → split summary mail and PDF of a new child show the rate.
