# Table headers: one consistent look

Status: **draft, awaiting approval.** Written 2026-10-07. No code changed yet.

## What the audit found

54 table headers across `app/` and `components/`, in **16 different styles**. The two shared
components already disagree with each other:

| Source | Background | Text |
|---|---|---|
| `components/ui/table.tsx` `TableHead` (base) | `bg-background` (page colour) | `font-medium text-muted-foreground`, h-10 |
| `components/ui/sortable-table-head.tsx` | `bg-muted/50` (grey band) | same |

So a Masters page using sortable headers (SKUs via `DataTable`, Material Master, RM/PM cost) shows a
grey header, while one using plain `TableHead` (Vendors, Manufacturers, Warehouses, Recipe) shows a
white one. On top of that, 14 raw `<th>` tables style themselves:

| Style family | Where | Look |
|---|---|---|
| Shared default (29) | Masters, Admin, Manufacturing, GatePass, Observability, entity-emails | page bg, normal case |
| Sortable (3) | `DataTable`, `MaterialRateTable`, Material Master | grey band, normal case |
| Small-caps (4) | Approvals diff tables, `HistoryEntry`, CSV preview | grey band, 10px UPPERCASE, tracked |
| Bare `<th>` (6) | Invoices group table, SKU summary, three-way dialog | **no classes** — browser default bold + centred |
| One-offs (12) | PO table, MFG facility matrix, costing breakup, Add PO, Uniware explorer, CSV import, MFG overview, monthly PO summary | each its own mix of bg, padding, size |

## Governing rule

**The header look lives in one place — the shared `TableHead`.** `SortableTableHead` and every raw
`<th>` table take it from there. A table may still set its own *layout* (width, alignment, sticky,
padding for compact tables) but not its own *look* (background, colour, size, weight, case).

## Scope

Header styling only. Not changed: columns, sorting behaviour, sticky behaviour, row/cell styling,
table layout, or any new UI.

## Decisions (owner: Ajay)

| # | Decision | Recommendation |
|---|---|---|
| D1 | The one look | **Grey band, normal case**: `bg-muted/50`, `font-medium`, `text-muted-foreground`, `text-xs`. It is what the main Masters tables (sortable) already show, and it separates header from rows on long lists. Alternative: the small-caps style from Approvals. |
| D2 | Compact tables (11px nested tables in Invoices, three-way dialog, facility matrix) | Same look, keep their tighter padding/height — only colour, weight, size and case are unified. |
| D3 | `CsvImportDialog` / `CsvPreviewDialog` previews | Bring them in line too (they are tables people read). |

## Phases and gates

**Phase 1 — Set the standard in the shared components.** `TableHead` gets the D1 look;
`SortableTableHead` stops overriding the background. This alone changes the 32 shared-component tables.
*Gate:* Ajay checks one page per family on local dev (e.g. Vendors, SKUs, Recipe, an Admin table)
and approves the look before anything else moves.

**Phase 2 — Strip per-table look overrides.** Remove `bg-*`, `text-[10px]`, `uppercase`, `tracking-*`,
`font-semibold` overrides on shared headers (Approvals diff tables, `HistoryEntry`, PO table,
Uniware explorer, monthly PO summary). Layout classes stay.
*Gate:* visual pass of those pages.

**Phase 3 — Bring raw `<th>` tables in.** The 14 raw tables either switch to `TableHead` or, where
they are dense nested tables, apply the same exported header class. Bare `<th>` tables (Invoices)
gain left alignment back explicitly where their columns expect it.
*Gate:* visual pass of Invoices, three-way dialog, facility matrix, costing breakup, Add PO, CSV import/preview.

**Phase 4 — Guard.** A lint rule or check that flags look classes on `TableHead`/`th`, so drift is
caught in review.

## Risks

1. **Alignment shift on bare `<th>` tables.** They are centred today by browser default; numeric
   columns that rely on that need an explicit `text-right`/`text-center`. Checked per table in Phase 3.
2. **Dark mode.** `bg-muted/50` must read in both themes — checked in the Phase 1 gate.
3. **Sticky headers over rows.** A header that becomes semi-transparent can show rows through it while
   scrolling; sticky tables keep an opaque or blurred background (layout, allowed).

## Rollback

Pure styling; revert the commit.

## Progress

- **D1–D3 approved as recommended (2026-10-07).**
- **Phase 1 done** — `TableHead` carries the look; `SortableTableHead` no longer overrides it. Approved on dev.
- **Phase 2 done** — look overrides removed from Approvals diffs, `HistoryEntry`, PO table, Uniware, monthly PO summary.
- **Phase 3 applied** — `components/ui/table.tsx` exports `HEAD_BG` (on `<thead>` and sticky `th`s) and
  `HEAD_ROW_LOOK` (row-level size/weight/colour) for the 16 hand-written header blocks in 11 files.
  Background deliberately not set from the row: a `[&>th]:` class outranks a th's own class, which would
  erase the facility matrix's selected state and the sticky columns' fills. Costing breakup header padding
  `pb-1` → `py-1` now that it sits on a band.
- **Found, not changed:** rows with `[&>th]:text-left` (invoice tables, three-way dialog, inward line items)
  outrank `text-right` on their numeric `th`s, so those headers render left-aligned over right-aligned numbers.
- **Phase 4 done** — `erp/table-header-look` in `eslint.config.mjs` (`no-restricted-syntax`): look classes on
  header cells, `bg-*` on `thead`/`TableHeader`, and look classes via `[&>th]:` are errors in `app/` and
  `components/`. Allowed: `bg-accent` / `bg-inherit` on a cell, `HEAD_BG` / `HEAD_ROW_LOOK` (identifiers).
  Verified on a probe file (3 of 3 caught, selected state passed). One exemption: the costing breakup's
  in-body section label, which is not a column header.
- **Not part of this work:** the PO list's frozen PO No. column was dropped by merge `a10f875` (2026-08-10);
  restore is a separate change, deferred by Ajay.
