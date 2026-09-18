# MFG Cost Manager — four changes

**Status: PLANNED, not started.** Written 2026-09-18. Nothing below has been
built; three of the four need an answer from §0 first.

| # | Ask | Shape | Risk |
|---|---|---|---|
| 1 | Agreed Final Costing: paginated server-side search | UI + one query | low, but see §0.1 — it may not be worth doing |
| 2 | Discontinued recipes out of active lines, into an archive view | UI + one query | **medium** — the same query feeds costing |
| 3 | Misc-cost CSV: enums in the template, validate before approval | UI + validation | low |
| 4 | `bom_misc` keyed on the SKU, not the recipe | **migration** + 12 files | **DEFERRED 2026-09-18** |

Sequenced 3 → 1 → 2. Three is self-contained and stops a live annoyance.

> **Change 4 is deferred, not dropped.** §4 below is kept because the expensive
> part is already done: the migration was measured against prod and is clean
> (§4.1), and the blast radius is mapped (§4.4). Re-run the §4.1 check before
> acting on it — it is only safe while no SKU has misc rows against two recipes.
> The thing it would fix is still true meanwhile: a new recipe version starts
> with no misc costs, because they belong to the superseded recipe.

---

## 0 · Gates — answer before building

These are not rhetorical. Each one changes what gets built.

### 0.1 — Is pagination actually wanted here?

Measured on prod, live lines per manufacturer:

```
MFG-014-REV  52      MFG-001-CHE  15      MFG-010-KAI  11
MFG-005-NGE  29      MFG-016-SAM  15      MFG-011-ALL   8
MFG-012-ANA  24      MFG-003-ARO  14
```

**The largest manufacturer has 52 rows.** Pagination will not make that page
faster to read, and client-side search over 52 rows is instant.

What IS heavy is the computation behind each row: the page loads every line,
then derives material cost, misc cost, wastage and three vendor scenarios
(min / max / approved) plus a breakup per row. Paginating would let it compute
25 rows instead of 52 — a real saving, but of something already fast.

So: **paginate for consistency with the rest of the app, or leave it?** If the
answer is "it will grow", pagination is right and this is cheap insurance. If
the answer is "52 is the ceiling", this is complexity bought for nothing and
I would rather not build it. Your call, and I will build it either way.

### 0.2 — Which "discontinued" moves to the archive?

Two different columns both hold that word, and prod has both:

```
line status    recipe status     rows
active         active            194
discontinued   discontinued        2
active         inactive            1     <- an anomaly, see below
inactive       inactive            1
```

- **`master_recipe_mfg.status`** — this manufacturer stopped making it.
- **`master_recipe.status`** — the FORMULATION was superseded (supersession
  stamps `discontinued`, per CLAUDE.md).

"the SKUs' recipes that are discontinued" reads as the **recipe**, but on prod
those are the same 2 rows either way, so the data cannot settle it. Pick one.

> ⚠️ **The 1 active line on an `inactive` recipe is worth knowing about
> regardless.** It is producible today against a formulation nobody approved.
> Whatever the archive rule is, that row should surface somewhere rather than
> sit in the active list looking normal.

### 0.3 — Does archiving change Agreed Final Costing? (the one that can bite)

`selectLiveLinesByMfg` is `status IN ('active','discontinued')` and its comment
says why: *"a discontinued line is still producible, so its costing still
applies"*. That query feeds **Agreed Final Costing and the PO rate quote**, not
just the Lines tab.

So: does "move to archived view" mean
- **(a) hide them on the Lines tab only** — costing and PO rates unchanged, or
- **(b) stop costing them too** — which changes what a PO can be raised at?

**(a) is what I will build unless told otherwise.** (b) silently changes
rates on 2 live lines and needs saying out loud.

### 0.4 — Misc cost per SKU: per (SKU, manufacturer), or per SKU globally?

`bom_misc` is keyed `(bom_id, mfg_id, type)` today. Job work and shrink wrap are
negotiated *with a manufacturer*, so I read "associated to the SKU" as dropping
the RECIPE, not the manufacturer — i.e. `(sku_id, mfg_id, type)`. Confirm, because
dropping `mfg_id` as well would merge rows across manufacturers and lose data.

---

## 1 · Change 3 — misc-cost CSV (do this first)

Two separate problems the ask names.

**The template does not carry the allowed values.** `MISC_COST_BULK_CSV_FIELDS`
already declares them (`jw`, `shrink`, `shipper`, `rm_loss`, `pm_loss`) and
validates on upload, but the downloaded file says nothing — so the desk types a
guess and finds out later. Fix: emit the permitted values into the template
itself (a header comment row for CSV, real data-validation dropdowns for xlsx),
generated from `MISC_COST_TYPE_OPTIONS` so the file can never list a value the
validator then rejects.

**The expensive check runs after approval.** `bomMiscBulkHandler` refuses a row
whose SKU *"has no recipe linked to this manufacturer"* — and that happens in
`applyAndArchive`, i.e. after someone has approved the file. Worse, one bad row
throws and rolls back the whole batch, so an approver's click is wasted on a
problem visible at upload time.

Fix: check it at upload, in the preview, against the manufacturer's own lines.
The existing `selectMfgLineOptions` already returns exactly that list.

**The handler check stays.** The upload guard is a better error message, not a
replacement — the file is staged in S3 and applied later, and a line can be
retired between upload and approval.

---

## 2 · Change 1 — paginated Agreed Final Costing

Only if §0.1 says yes.

Server-side `page` / `size` / `search` on the tab, matching
`parsePaginationParams` and the `UrlSearchInput` pattern the masters pages use,
so the URL carries the state and a reload keeps it.

The subtlety: **the page computes costing in TypeScript after the query**, so
paginating the line query alone is not enough — the material-cost, misc-cost and
vendor-scenario queries are per-manufacturer and would still fetch everything.
Either scope those to the page's recipe ids, or accept that only the render is
paginated. The first is the point of the exercise; the second is theatre.

Search must be server-side or it only searches the page — the trap the invoices
Match filter already has, and the reason its caption says "on this page".

---

## 3 · Change 2 — archived lines view

Per §0.2/§0.3, assuming (a):

- Lines tab shows active lines only.
- An **Archived** toggle (button, not a new page) swaps the same table to the
  archived set — same columns, same component, one extra query parameter.
- `selectLinesByMfg` already takes a status filter, so this is a parameter, not
  a new query.
- The tab badge counts stay honest: `statusCountsByMfg` already returns per-status
  counts, so the button can carry the number.

**`selectLiveLinesByMfg` is not touched**, which is what keeps costing and PO
rates where they are.

---

## 4 · Change 4 — `bom_misc` keyed on the SKU

The one that rewrites data. Do it last, and on dev only until it has been read back.

### 4.1 The migration is clean — measured, not assumed

```
bom_misc: 322 rows across 75 recipes, 6 manufacturers
(sku, mfg, type) groups spanning >1 recipe: 0
of which the costs disagree:                0
```

**No SKU has misc rows against two recipes**, so the remap is 1:1 and there is
no merge decision to get wrong. If that ever stops being true, this plan needs
rewriting — re-run the check before applying.

### 4.2 Shape

```sql
ALTER TABLE bom_misc ADD COLUMN sku_id INT NULL AFTER id;
UPDATE bom_misc bm JOIN master_recipe b ON b.id = bm.bom_id SET bm.sku_id = b.sku_id;
-- then NOT NULL, an FK to master_skus, and a UNIQUE (sku_id, mfg_id, type)
-- on the ACTIVE rows only if the history rows allow it — check first.
```

> MySQL 8 has **no `ADD COLUMN IF NOT EXISTS`**, so this migration is not
> re-runnable. It needs the usual header saying so.

**`bom_id` is kept, not dropped**, in the first pass. Dropping it is a separate
migration once the new column has been read in anger — and it is what makes the
whole change reversible by a deploy.

### 4.3 What it fixes beyond tidiness

Today a new recipe version starts with **no misc costs**: they were attached to
the superseded recipe. Keying on the SKU means JW/shrink/shipper/wastage survive
a formulation change, which is what everyone already assumes happens. Worth
checking whether any live SKU has lost its misc costs this way — the query is
"active recipes whose SKU has misc rows only against an older recipe".

### 4.4 Blast radius

12 files reference `bom_misc`. The ones that matter:

| File | Why |
|---|---|
| `lib/queries/manufacturing.ts` | 8 SELECTs, all aliasing `bom_id AS recipe_id` |
| `lib/approvals/handlers/misc-cost.ts` | MFG_MISC + MFG_MISC_BULK apply/archive |
| `app/manufacturing/[mfgId]/costing-breakup.ts` | Agreed Final Costing |
| `app/api/v1/purchase-orders/quote-rate/route.ts` | the rate a PO is raised at |
| `lib/validation/manufacturing.ts` | Zod shapes |
| `tests/db/misc-cost-approval.test.ts` | the existing pin |

⚠️ **The `bom_id AS recipe_id` alias is a documented trap** (CLAUDE.md): the row
types key on `recipe_id`, and `query<T>` is an unchecked cast, so a wrong column
name compiles, type-checks, lints — then reads `undefined` and silently zeroes
JW/Shrink/Shipper/Wastage on Agreed Final Costing and in the PO quote. That has
happened before. Every touched SELECT needs reading back against real data, not
just a green build.

### 4.5 Gate before the UI moves

Add the column, backfill, and **verify the two costing surfaces still produce
identical numbers** — Agreed Final Costing and `quote-rate` for the same SKU ×
manufacturer, before and after. Only then switch the queries to `sku_id`.

---

## 5 · Verification

```bash
npm test
npx tsc --noEmit --incremental false     # not plain tsc
npm run lint:changed
npm run build                            # dev server must be down
npm run test:checks -- --db
```

Plus, specific to this work:

1. Agreed Final Costing totals for `MFG-014-REV` (52 lines) match to the paisa
   before and after change 4. This is the check that matters.
2. `quote-rate` returns the same rate for a known SKU × manufacturer before and after.
3. A misc-cost CSV with a bad `type` and a SKU the manufacturer does not make is
   rejected **at upload**, with both problems named, and never reaches an approver.
4. The archived view and the active view together account for every line
   `statusCountsByMfg` reports — nothing falls between them.
