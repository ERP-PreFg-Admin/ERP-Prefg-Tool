# MFG Cost Manager — four changes

**Status: all four implemented (2026-08-11).** Decisions taken: PM approved rate
uses the existing best-effort pick; new misc-cost lines insert as `in_review`;
the CSV bulk import is gated too (`MFG_MISC_BULK`). See the notes at the end of
each section.

**Layout revised after review:** the three vendor scenarios are **stacked**, not
behind the segmented toggle proposed below. The columns being identical is the
reason to stack rather than toggle — the same row reads straight down across
approved / cheapest / priciest, so the scenarios are compared against each other
and not only against the MRM rate. A toggle put two-thirds of that behind a click.

---

## 1. SKUs tab → "SKU Manager"

`app/manufacturing/[mfgId]/TabBar.tsx:13` — label `"SKUs"` → `"SKU Manager"`, and drop
the counts suffix at `:41-45` (`(3 active / 0 discontinued / 0 inactive)`), which is what
makes that tab twice the width of every other one.

The counts still come from `statusCounts`, which is passed in from `page.tsx`. If nothing
else consumes it, the prop goes too — otherwise it stays and only the render drops.

One file, ~6 lines. No API, no DB.

---

## 2. "Add SKUs" — one at a time → multi-select

`LineDialog.tsx` currently holds a single `recipe_id` string and posts one
`action: "create"` to `/api/v1/manufacturing/lines`. Every other field the form used to
carry was already stripped out — the dialog is now *only* the SKU picker, which is why
multi-select is a small change.

**No new component.** `FuzzySelect` stays for search; the change is:

- `form.recipe_id: string` → `recipe_ids: string[]`
- picking an option appends instead of replaces; picked SKUs render as removable chips
  below the input, and already-picked ids are filtered out of `options`
- `handleSubmit` in the create branch posts once per selected id

### Where the loop goes

| Option | Cost | Behaviour on partial failure |
|---|---|---|
| **A. Client loop** (`for` over ids, N requests) | ~0 — no API change | Some added, some not; toast reports "added 4 of 6" |
| **B. New `create-many` action** (one request, one transaction) | Route + Zod schema + a `beginTransaction` | All-or-nothing |

**Recommend A.** Adding a manufacturing line is idempotent-ish and independently useful —
if SKU 5 of 6 fails because it's already linked, having the other 5 in is the right outcome,
not a rollback. B also needs the duplicate-key handling A gets for free.

`onSaved()` fires once after the loop, so the table refreshes a single time.

**Edit mode is unchanged** — editing is inherently one row.

---

## 3. Agreed Final Costing — 3 tables → 4

Today `FinalCostingTabContent` (`page.tsx:165-300`) renders three:

1. `FinalCostingTable` — agreed **MRM** (manufacturer) rates
2. Cheapest available vendor rate (`buildComparisonRows("min")`)
3. Most expensive available vendor rate (`buildComparisonRows("max")`)

You want four: **mfg costing · vendor costing · min · max**. So the new one is #2 in your
list — costing at the **approved vendor's** rate, sitting between the MRM table and the
min/max pair.

### The mechanism already exists

`buildComparisonRows(scenario)` is already generic over a rate map. Adding a scenario is
adding a third map, not a third code path:

```ts
function buildComparisonRows(scenario: "min" | "max" | "approved")
```

`rmRateMap`/`pmRateMap` gain an `approved` key alongside `min`/`max`, and the two
`selectMinMax*` queries gain a sibling that returns the approved vendor's current rate per
material.

### The asymmetry that has to be decided

`cost_master_rm_mfg` **has** an `approved_vendor_id` column — `selectRmVendorByMfg` already
joins it to `master_vendors`. So for RM, "the approved vendor's rate" is exact: look up
`cost_master_rm_ven` for `(rm_id, approved_vendor_id)`.

`cost_master_pm_mfg` **has no such column.** The Approved Procurement Rates tab already
works around this — `selectPmVendorByMfg` picks "whichever active `cost_master_pm_ven` row
exists for that PM" via a correlated subquery, explicitly commented as best-effort. The new
table would inherit that same guess for its PM half.

Two ways to handle it, and this is a question for you, not a judgement call I should make:

- **(a)** Mirror the existing best-effort pick for PM. Consistent with the tab that already
  ships, but a PM with several active vendors silently costs at an arbitrary one.
- **(b)** Add `approved_vendor_id` to `cost_master_pm_mfg` so PM matches RM. Correct, but
  it's a migration plus a UI to set it, and until it's populated the column is null and the
  table shows blanks.

### Layout

Four tables stacked is a lot of vertical scroll for what is really one comparison. Options:

- **Stacked** (what happens today, just one more) — simplest, no new component.
- **Segmented toggle** over the three vendor scenarios (approved / min / max), MRM table
  always on top. `components/ui/segmented-toggle.tsx` already exists and is used elsewhere.

**Recommend the toggle** — the three vendor tables have identical columns, so stacking them
means reading the same header three times.

### Exports

`final-costing/export` and `final-costing/detailed-export` both rebuild these rows
server-side, independently of the page. The new scenario has to be added in **both** or the
CSV silently disagrees with the screen. That is the bulk of the work in this item.

---

## 4. Misc. Cost must go through approval

Today `/api/v1/manufacturing/misc-costs` writes straight to `bom_misc` — the route header
says so explicitly: *"No approval flow, same directness as /api/v1/manufacturing/lines."*
JW / Shrink Wrap / Shipper / Wastage % all feed `Total Costing`, so these are rate changes
with the same money impact as the RM/PM rates that **do** require approval.

### What it needs

**A. A schema change — unavoidable.** `bom_misc.status` is
`enum('active','inactive','discontinued')`. The approval flow locks an entity by setting
`status = 'in_review'`, so:

```sql
ALTER TABLE bom_misc
  MODIFY COLUMN status ENUM('active','inactive','discontinued','in_review','rejected')
  DEFAULT 'active';
```

Applied to **both** schemas, as a `prisma/*.sql` file with the usual header, and mirrored
into `schema.prisma`. MySQL 8 has no `IF NOT EXISTS` for this, so it is not re-runnable.

**B. A new module handler.** One object added to `MODULE_HANDLERS` in
`lib/approvals/module-handlers.ts` — module code `MFG_MISC`. The approve/reject route picks
it up with no change, per the strategy pattern. Also needs entries in `MODULE_LABEL`,
`MODULE_COLOR` and `entityLabelSql`, which is exactly the registry gap that bit the four
`*_BULK` modules earlier.

**C. Edits vs creates behave differently, and this is the second thing to decide.**

*Edits* fit the standard pattern cleanly: diff the fields, insert `approval_items`, set the
row to `in_review`, `applyAndArchive` writes it back. Same shape as `RM_RATE`.

*Creates* have no entity to lock yet — there is no row id until it exists. Two ways:

- **(a) Insert immediately as `in_review`.** The row exists but is invisible to costing,
  because every costing query already filters `status = 'active'`. Approval flips it to
  `active`; rejection to `rejected`. Cheapest, and reuses the `entity_id` mechanism as-is.
- **(b) Stage the payload in the approval** and only INSERT on approve, like the `*_BULK`
  modules do with their CSVs. No phantom rows, but it needs somewhere to hold the payload
  and doesn't fit the field-diff shape.

**Recommend (a)** — the `status = 'active'` filter is already load-bearing everywhere, so an
`in_review` row is inert by construction.

**D. Remarks.** Every other approval-flowed master requires `remarks` on edit
(`z.string().trim().min(1)`). Misc cost should match, which means adding the field to
`MiscCostDialog` and the Zod schema.

**E. The bulk CSV path.** `action: "bulk"` inserts row-by-row directly. If misc costs need
approval, the CSV import needs it too — otherwise it's a documented bypass of the control
being added. That means a `MFG_MISC_BULK` module alongside, matching the other nine
`*_BULK` modules.

### Scope note

Item 4 is meaningfully bigger than 1–3 combined: a migration, two new approval modules, four
registry entries, dialog changes, and the bulk path. It is the one item I would split into
its own commit.

---

## Order

1 → 2 → 3 → 4, smallest first, each independently shippable.

## Verification

- `npx tsc --noEmit`, `npm test`, `npm run lint:changed` on every item
- item 3: a live check that the four tables' RM/PM totals agree with the two export routes
- item 4: submit a misc cost, confirm it does **not** appear in costing while `in_review`,
  approve it, confirm it does — in a rolled-back transaction
