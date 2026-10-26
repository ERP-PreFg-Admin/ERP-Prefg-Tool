# Reporting — Reports tab design

**Status (2026-10-26):** proposed, grounded in existing components. No new infrastructure, no chart library in Phase 1.

## Navigation
- **Sidebar:** a top-level **Reports** item (the already-imported, unused `BarChart2` icon) → `/reports`.
- **Slug:** `/reports` already exists in `lib/pages.ts` as "Planned", `nav: false`. Flip it to `nav: true` so the sidebar resolves access. **Nothing grants it today** (the seed script doesn't), so access starts with an explicit grant in /admin → Permissions.
- **Guard:** `app/reports/layout.tsx`, copied from `app/observability/layout.tsx` (`resolveAccess(…, "/reports")`, redirect on none).

```
/reports                  catalogue: search + category groups
/reports/[reportId]       one report: filters · totals strip · table · export
```

One shared workspace with one page per report, not separate modules. Every report has the same shape (filters → table → export), so a registry drives it.

## Access (decided: Reports + source page)
Each registry entry declares `sourcePageSlug`:

| Report | Source page |
|---|---|
| PO-01, PO-02 | FG PO Tracking slug |
| INV-01, INV-02 | PO Inwarding slug |
| DQ-01 | each check carries its own source slug; checks the viewer can't open are hidden |

- **Catalogue:** lists only the reports the viewer can open.
- **Report page and export:** both re-check `/reports` **and** the source slug at viewer level, server-side. The hidden card is never the guard.
- **Rows:** scoped with `getViewScope` (brand switcher ∩ grant), through `scopeClause` / `scopeParams`. Invoice reports filter brand **per line**, so the invoice-export leak (review C4) can't repeat here.
- **Export:** calls the **same service function** as the page, so the file can never hold rows the screen wouldn't.

## Report page layout
1. **Header:** name, the question it answers, a "Definitions" disclosure (metric rules from `analyst-use-cases.md`), and a freshness line (e.g. "GRN data last synced 3 days ago" from MIN/MAX `uniware_synced_at`, or "Live").
2. **Filter bar:**
   - `UrlSearchInput` for the text search;
   - `FilterPanel` / `FilterField` with `FuzzySelect` for mfg, brand, SKU and destination (options from the cached lists, post-filtered by `filterByScope`);
   - `DatePicker` ranges;
   - `SegmentedToggle` for the report's tabs (e.g. INV-01 exceptions / INV-02 rate).
   - All state lives in the URL via `useUrlFilters`, so a filtered report is a shareable link.
3. **Totals strip:** a few numbers computed over the **whole filter**, not the page. Only where they drive action (open qty, open value pre-GST, overdue POs, unpriced count).
4. **Table:** `DataTable` with a `ColumnDef[]`, server pagination (`parsePaginationParams` + `paginate`), `PaginationBar`, `RecordCountHeader`, `TableEmpty`, `TruncatedCell`. Sorting is **server-side** for reports, because a page-only client sort misleads on totals.
5. **Export:** `DownloadButton` → `/api/v1/reports/[id]/export?format=xlsx|csv&…filters`.

Value columns sit as a pair, "Value (pre-GST)" and "Value (incl. GST)". Totals use pre-GST. The GST column header carries a tooltip about the known GST-master errors. Unpriced and special POs show "—" plus a price-class badge, never ₹0.

States:
- **Loading:** Suspense skeleton.
- **Empty:** `TableEmpty` with "Clear filters".
- **Error:** the gateway's `{error, requestId}` shown with the request id.
- **Over-cap export:** 413 with the row count, telling the user to narrow the filter.

## Code layout

| Piece | Path | Pattern copied |
|---|---|---|
| Registry | `lib/reports/catalog.ts` | — (pure; id, name, category, question, sourcePageSlug, filters, columns, notes) |
| Shared definitions | `lib/reports/definitions.ts` | pure + unit tests (`lib/po/po-rules.ts`) |
| SQL | `lib/queries/reports.ts` | imports exported building blocks from `lib/queries/purchase-orders.ts` |
| Services | `lib/services/reports/<id>.ts` | `lib/services/mfg-overview.ts` (`getViewScope`, `timedQuery`) |
| Access helper | `lib/services/reports/access.ts` | `resolveAccess` × 2 |
| Pages | `app/reports/page.tsx`, `app/reports/[reportId]/page.tsx` + one client table per report | `po-procurement/page.tsx` |
| Export | `app/api/v1/reports/[reportId]/export/route.ts` | `purchase-orders/export/route.ts` (count → 413 at 50k → `exportResponse`) |

`app/**` never imports `lib/db` or `lib/queries` (the ESLint `ui-data-boundary` rule). Pages call `lib/services/reports/*`.

## Where calculations live
- **SQL:** filtering, scope, aggregation, sorting, pagination, open-qty math. One statement per report page plus one COUNT/totals statement.
- **Server TS:** three-way leg states (`three-way.ts` is already TS), price class labels, IST date windows.
- **Precomputed tables:** none in Phase 1. Revisit only if a dev `EXPLAIN` or prod timing shows a report over ~1s. Phase 3 inventory snapshots are the exception, because that data doesn't exist to compute live.
