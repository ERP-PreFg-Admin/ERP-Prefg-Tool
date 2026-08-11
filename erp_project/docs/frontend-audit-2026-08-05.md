# Frontend Audit — UI/UX + Code Modularity

**Date:** 2026-08-05
**Scope:** `erp_project/app`, `erp_project/components`, `erp_project/lib`, `erp_project/types`
**Method:** static read of the codebase. The app was **not** run, so nothing here is screenshot-verified — every finding is traced to a file and line so you can confirm it in seconds.

---

## TL;DR

The structure is in better shape than most ERP frontends this size. Server/Client split is disciplined, `lib/` is properly partitioned (`queries/`, `validation/`, `approvals/handlers/`, `gateway/`, `master-routes/`), the masters pages genuinely compose from ~10 shared primitives instead of copy-paste, the largest hand-written file is 648 lines, and there are only 13 `any` across all 129 `.tsx` files.

**What's pending is mostly half-finished migrations and unadopted primitives — not architectural debt.** Two things are outright user-facing bugs (wrong approval copy, dead search box). Items 1–7 in the work plan are each small and independently shippable.

**Counted evidence:**

| Metric | Value |
|---|---|
| `.tsx` files in `app/` + `components/` | 129 |
| Files with hardcoded palette colours (`bg-blue-500`, `text-zinc-400`, …) | **71** (157 occurrences) |
| Files with any `dark:` variant | 35 (69 occurrences) |
| Raw `fetch(` calls in client components | **73** across 44 files |
| `eslint-disable react-hooks/set-state-in-effect` | **56** across 35 files |
| `aria-label` occurrences | 17 across 13 files |
| `loading.tsx` / `error.tsx` / `not-found.tsx` in `app/` | **0** |
| Test files / test runner | **0** |

---

# P1 — UI/UX

### 1. Two dead controls sit on every page

**`components/TopBar.tsx:20`** — a bare `<Input placeholder="Search…">`. No state, no handler, no form. It renders on every authenticated page.
**`components/TopBar.tsx:29`** — Bell button, no `onClick`, no `aria-label`, no badge.

In a data-heavy ERP the top-bar search is the highest-affordance element on screen. Users will click both. Shipping a control that does nothing is worse than not shipping it.

**Fix:** wire them, or delete them until they're real. If search is coming, a disabled input with a "Coming soon" tooltip is honest; a live-looking one isn't.

---

### 2. User-facing copy is factually wrong about the approval flow

**`app/page.tsx:145`** tells every user:

> "BOM edits are the one exception — they save immediately and don't require approval."

That is not what the code does:

- `app/api/v1/masters/recipe-master/route.ts:133` — checks `approvalsSql.hasPending` for `"BOM"`
- `app/api/v1/masters/recipe-master/route.ts:157` — inserts a `BOM` approval record
- `lib/approvals/module-handlers.ts:51-52` — registers `BOM` and `BOM_BULK` handlers

Someone editing a recipe will believe the change is live while it's actually sitting in the approvals queue.

The same stale claim is in **`CLAUDE.md`** (API Routes table: *"recipe-master/ — BOM CRUD + export (no approval flow)"*), which contradicts its own Registered Modules table two sections earlier. Agents read that file, so it needs fixing too.

**Fix:** correct both. BOM goes through approval like everything else.

---

### 3. The dashboard isn't a dashboard

`app/page.tsx` is ~120 lines of prose documentation. Specific problems:

| Line | Issue |
|---|---|
| `:31` | Opens with a stray horizontal rule — `border-t border-border pt-8` with nothing above it |
| `:8-16`, `:24-26` | The module grid that used to sit above that border is commented out |
| `:33` | Page starts at `<h2>`; there is no `<h1>` anywhere on the landing page |
| `:2`, `:21-22` | `resolveAccess` imported but only used in dead comments; `userId` and `roles` computed and never read |

Users live in Approvals and PO Tracking. Their first screen shows **zero data** — no pending-approval count, no POs awaiting action, no recent activity, no shortcuts.

**Fix:** rebuild `/` as a real dashboard (pending approvals for me, POs awaiting action, recent activity). Move the guide content to `/help` and link it from the sidebar — it's good content in the wrong place.

---

### 4. Every scrollbar in the app is hidden

Three places, all deliberate:

- `components/ui/table.tsx:6` — `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden` on the table's overflow container
- `components/ClientLayout.tsx:30` — `scrollbar-none [&::-webkit-scrollbar]:hidden` on `<main>`
- `components/Sidebar.tsx:163` — same on the nav

Vendors is a 10-column table; RM/PM rate tables are wider. When they overflow horizontally there is **no indication more columns exist and nothing to drag.** Shift+wheel and trackpad-swipe still work, but discoverability is zero — most users will never know there are columns off-screen.

**Highest-impact defect in this audit.**

**Fix:** either restore scrollbars on `Table` and `<main>`, or add an explicit affordance (edge fade + a right-edge chevron). Keeping the sidebar's hidden is fine — that one doesn't hide information.

---

### 5. Dark mode flashes white on every page load

- `app/layout.tsx:47` — `themeScript` is defined (correctly: reads localStorage, adds `.dark` before paint)
- `app/layout.tsx:87` — the `<script dangerouslySetInnerHTML>` that runs it is **commented out**
- `components/ThemeProvider.tsx:15-22` — applies `.dark` in a `useEffect`, i.e. after hydration

Result: every dark-mode user gets a white flash on every full page load. `suppressHydrationWarning` is already on `<html>` (`layout.tsx:76`) specifically to support this script.

**Fix:** uncomment line 87. One line.

---

# P2 — UI/UX

### 6. No route-level loading or error boundaries anywhere

Zero `loading.tsx`, `error.tsx`, `not-found.tsx`, or `global-error.tsx` under `app/`.

Every page is a Server Component running multiple SQL queries — the root layout alone does `getUserScope` + `manufacturingSql.selectActiveForNav` + a `resolveAccess` per sidebar slug (`app/layout.tsx:56-71`). Consequences:

- Slow pages hang on the *previous* screen with no skeleton — reads as a frozen app
- An uncaught throw in any Server Component shows Next's default error page
- No branded 404

**Fix:** one `loading.tsx` per route group (table skeleton), one `error.tsx` at `app/` with a retry, one `not-found.tsx`.

---

### 7. Sticky table headers were adopted piecemeal

Present in 8 places — `app/po-tracking/po-procurement/PoTable.tsx:86`, `components/masters/CsvImportDialog.tsx:445,519`, `app/approvals/CsvPreviewDialog.tsx:72`, `app/po-tracking/po-inwarding/InvoiceLineItems.tsx:42`, `InvoiceHistoryDialog.tsx:171`, `app/manufacturing/ManufacturingOverviewClient.tsx:29`.

Absent from the shared `components/ui/table.tsx`. So the PO module keeps its header on scroll and **every masters table loses it.**

**Fix:** move `sticky top-0 z-10` into `TableHeader` in the primitive; drop the per-file overrides.

---

### 8. Icon-only actions aren't accessible

Only **17** `aria-label` occurrences in the whole frontend.

- Row-action columns use `title=` only — e.g. `app/masters/vendors/VendorsClient.tsx:248,256,265` (Edit / Documents / History pencils). `title` gives a mouse tooltip and is only a last-resort accessible-name fallback; it never appears on keyboard focus.
- **`components/Sidebar.tsx:254`** — locked nav items are non-focusable `<div className="cursor-not-allowed">`. The "No access" tooltip is mouse-only, so keyboard users can never find out *why* a page is missing.
- `components/Sidebar.tsx:151` — collapse button has no label.
- `components/Sidebar.tsx:208` — section triggers lack `aria-expanded` / `aria-controls`.

**Fix:** `aria-label` on every icon-only button (keep `title` for the mouse tooltip); make locked items `<button disabled>` or add `tabIndex={0}`; add `aria-expanded` to collapsibles.

---

### 9. No responsive story

`components/Sidebar.tsx:140` is a fixed `w-56` / `w-14` with no breakpoint, no drawer, no hamburger. `components/ClientLayout.tsx:26` is `flex h-screen overflow-hidden`. On a 375px viewport, 224px is nav.

Desktop-only is a legitimate choice for an internal tool — but right now it reads as accidental rather than decided.

**Fix:** decide explicitly. If desktop-only, add a `min-width` notice under `md`. If not, the sidebar becomes an overlay drawer below `lg`.

---

### 10. Breadcrumbs don't exist

`components/TopBar.tsx:16` is a single flat `<span>` showing the leaf label from `PAGE_LABELS`. On `/manufacturing/5` or `/masters/recipe-master/history` there's no path back up. `docs/frontend-patterns.md` describes breadcrumbs reading `lib/pages.ts`; only a leaf lookup is implemented.

---

### 11. `/settings` ships debug output as UI

`app/settings/page.tsx:15` renders to the user:

> Access level: **edit**

…on an otherwise "Module coming soon." stub. Internal permission state shouldn't be UI copy.

**Fix:** delete that line. Reachable by URL only (no sidebar link), so low blast radius — but it's live.

---

### 12. Design tokens leak

**157 hardcoded palette utilities across 71 of 129 `.tsx` files**, while only **35** files carry any `dark:` variant. So roughly 36 files are light-only by construction and will render wrong in dark mode.

Worst offenders by count: `components/masters/ApprovalBanners.tsx` (7), `app/po-tracking/po-procurement/PoProcurementClient.tsx` (10), `app/auth/signin/page.tsx` (6), `app/auth/unauthorized/page.tsx` (6), `components/ui/toast.tsx` (6).

Also a leftover experiment: **`components/Sidebar.tsx:30`** gives *only* the SKUs nav child an inline `<Dot className="text-blue-500" />` icon; the other six children have none.

**Fix:** map the recurring semantic cases (info / warning / success / destructive banners) onto the existing tokens in `app/globals.css`, then sweep. `components/ui/callout.tsx` already does this correctly — use it as the reference. Delete the `Dot` one-off.

---

### 13. Four Google font families load on first paint

`app/layout.tsx:29-32` loads Geist, Geist Mono, Outfit, and Merriweather. Body resolves to Outfit (`--font-sans`) and headings to Merriweather, so **`--font-geist-sans` is set but nothing uses it.**

Separately: Merriweather (a serif) is applied globally to `h1`–`h6` (`app/globals.css:130-132`). That's a defensible choice but it was inherited, not decided — worth a deliberate call for a dense data tool.

**Fix:** drop Geist sans if unused. Confirm the Merriweather decision or switch headings to Outfit at a heavier weight.

---

# P1 — Modularity & structure

### 14. There is no API client

**73 raw `fetch(` calls across 44 client components.** `lib/` has no api-client module.

Each call site independently re-implements: the loading flag, `res.json()`, error extraction from the gateway's `{ error, code, details, requestId }` shape, and toast dispatch. So `lib/gateway/with-gateway.ts` defines one typed error contract and **44 files interpret it 44 different ways.** Heaviest: `app/masters/material-master/EditMaterialDialog.tsx` (4), `AddMaterialDialog.tsx` (4), `components/masters/CsvImportDialog.tsx` (4), `app/masters/raw-materials/AddRawMaterialWizard.tsx` (3).

**Fix:** add `lib/api-client.ts` exposing something like `apiPost<T>(endpoint, body)` that throws a typed `ApiClientError` carrying `code` / `details` / `requestId`. Migrate incrementally — new code uses it, touched files convert.

---

### 15. The RM/PM typing migration is half done

`app/api/v1/masters/packing-materials/pm-handler.ts` is **fully typed** — `PmCreateBody`, `PmCheckDuplicateBody`, `PmCreateFullBody`, `PmAddRatesBody`, `PmBulkBody`, `PmS3BulkBody`.

Its mirror `app/api/v1/masters/raw-materials/rm-handler.ts` has **`body: any` on all 10 exported functions** — lines `36, 94, 109, 134, 146, 163, 194, 269, 355, 393` — and **24 `any` total**. It is the only outlier in the entire `app/api` tree; every other file has 1–3.

`lib/validation/raw-materials.ts` already defines 14 Zod objects, so the types exist — the handler just widens them away at the boundary.

**Fix:** mirror `pm-handler.ts` exactly. Mechanical, and the worked example is right there.

---

### 16. 56 suppressions of React's own lint rule

`eslint-disable react-hooks/set-state-in-effect` appears **56 times across 35 files**:

| File | Count |
|---|---|
| `components/masters/MaterialRateTable.tsx` | 11 |
| `app/masters/skus/SkusClient.tsx` | 6 |
| `app/masters/material-master/MaterialMasterClient.tsx` | 3 |
| `app/masters/vendors/VendorsClient.tsx` | 2 |
| `app/approvals/history/ApprovalHistoryClient.tsx` | 2 |
| …30 more files | 1–2 each |

Always the same shape — syncing a URL-derived prop into local draft state. Canonical example, `app/masters/vendors/VendorsClient.tsx:118-121`:

```ts
// eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft type when the URL-driven type filter changes
useEffect(() => setDraftType(currentType), [currentType])
// eslint-disable-next-line react-hooks/set-state-in-effect -- resets local draft zone when the URL-driven zone filter changes
useEffect(() => setDraftZone(currentZone), [currentZone])
```

React 19's lint rule is firing 56 times and every instance is silenced rather than solved.

**Fix:** one `useDraftState(value)` hook (or the `key`-reset pattern on the filter panel) replaces all 56.

---

# P2 — Modularity & structure

### 17. Dead file: `components/AppHeader.tsx`

No importer anywhere in the repo — `components/TopBar.tsx` is what `ClientLayout` renders. It also carries its own hardcoded `zinc-*` styling (`:10,14,26`), so it would drift immediately if revived.

**Fix:** delete.

---

### 18. Docs drift — both files agents are told to trust

- **`docs/frontend-patterns.md:158`** documents `components/ui/icon-action-button.tsx` as a shared primitive. **The file does not exist.**
- **`CLAUDE.md`** API Routes table claims recipe-master has "no approval flow" — contradicted by its own Registered Modules table and by the code (see finding #2).

**Fix:** remove the `icon-action-button` row (or build the component — several rate tables would use it); correct the BOM row.

---

### 19. Two parallel table stacks

The shadcn `Table` primitive, **plus 6 files with raw `<table>` / `<thead>`:**

`components/masters/CsvImportDialog.tsx`, `app/approvals/CsvPreviewDialog.tsx`, `app/manufacturing/ManufacturingOverviewClient.tsx`, `app/po-tracking/po-procurement/AddPODialog.tsx`, `app/po-tracking/po-inwarding/InvoiceLineItems.tsx`, `InvoiceHistoryDialog.tsx`.

Padding, sticky behaviour, and overflow drift independently per surface. `docs/frontend-patterns.md` papers over this by saying master tables "are plain HTML `<table>` elements" — accurate about the primitive's internals, misleading about which stack a new surface should use.

**Fix:** migrate the 6 to `Table`, or document explicitly when raw is correct (probably: only inside dialogs with bespoke scroll containers).

---

### 20. `EmptyState` adoption is partial — and the gap is one module

`components/ui/empty-state.tsx` is imported by ~10 surfaces. **~7 others hand-roll "No … found"**, and it's cleanly the **manufacturing module** that opted out:

`app/manufacturing/[mfgId]/ManufacturingLinesClient.tsx`, `MiscCostClient.tsx`, `FinalCostingTable.tsx`, `FinalCostingComparisonTable.tsx`, `MfgMonthlyPoSummary.tsx` — plus `app/admin/permissions/UserAccessTable.tsx` and `app/po-tracking/po-inwarding/InvoiceLineItems.tsx`.

**Fix:** swap in `EmptyState`. Empty screens should be an invitation to act, and right now the manufacturing tabs just say nothing's there.

---

### 21. `components/ui/` naming is inconsistent

Kebab-case throughout (`empty-state.tsx`, `sortable-table-head.tsx`, `segmented-toggle.tsx`) **except** `FuzzySelect.tsx` and `FileUpload.tsx`.

**Fix:** rename the two to kebab-case.

---

### 22. Zero test infrastructure

No test script and no vitest / jest / playwright in `package.json`.

This system computes money (`lib/costing/final-costing.ts`), computes the field-level diffs that drive the entire approval workflow, and matches CSV rows to existing records by business code (`lib/master-routes/edit-match.ts`). All three are places where a silent regression is expensive and invisible.

**Fix:** Vitest + unit tests on those three first. They're pure functions — cheap to cover, highest value per test in the repo.

---

### 23. Sidebar collapse state isn't persisted

`components/Sidebar.tsx:73` — `useState(false)`, no localStorage. Survives client-side navigation, resets on every full page load.

---

# Work plan

Ordered by (impact ÷ effort). Items 1–7 are each small and independently shippable.

| # | Change | Finding | Effort | Owner |
|---|---|---|---|---|
| 1 | Fix BOM approval copy on `/` + `CLAUDE.md` | #2 | minutes | |
| 2 | Uncomment the theme script in `layout.tsx:87` | #5 | 1 line | |
| 3 | Remove or wire the TopBar search + bell | #1 | small | |
| 4 | Un-hide scrollbars / add overflow affordance | #4 | small | |
| 5 | Sticky header into `components/ui/table.tsx` | #7 | small | |
| 6 | Type `rm-handler.ts` off existing Zod schemas | #15 | small, mechanical | |
| 7 | Add `loading.tsx` / `error.tsx` / `not-found.tsx` | #6 | small | |
| 8 | Delete `AppHeader.tsx`; fix `frontend-patterns.md:158` | #17, #18 | small | |
| 9 | Delete the `/settings` access-level line | #11 | 1 line | |
| 10 | `EmptyState` into the 7 hand-rolled surfaces | #20 | small | |
| 11 | Rebuild `/` as a real dashboard; guide → `/help` | #3 | medium | |
| 12 | `lib/api-client.ts` + migrate the 73 fetches | #14 | medium, incremental | |
| 13 | `useDraftState` hook; delete 56 eslint-disables | #16 | medium, mechanical | |
| 14 | `aria-label` sweep + focusable locked nav items | #8 | medium | |
| 15 | Token sweep on the ~36 light-only files | #12 | medium | |
| 16 | Breadcrumb trail in `TopBar` | #10 | medium | |
| 17 | Decide desktop-only vs responsive, then commit | #9 | medium/large | |
| 18 | Vitest + tests on final-costing, diff, edit-match | #22 | large | |

Deferred / judgement calls (no action until someone decides): #13 font stack, #19 table-stack consolidation, #21 file renames, #23 sidebar persistence.

---

## What's already good — don't regress it

Worth stating so nobody "cleans up" these while working through the list:

- **Server/Client split is disciplined.** Data fetching + `resolveAccess` in Server Components, interactivity in Client Components. Consistent across every module.
- **`lib/` is properly partitioned** — `queries/`, `validation/`, `approvals/handlers/`, `gateway/`, `master-routes/`, `costing/`. Domain boundaries are real.
- **The masters pages genuinely compose.** `VendorsClient.tsx` pulls in `MasterToolbar`, `UrlSearchInput`, `FilterPanel`, `RecordCountHeader`, `EmptyState`, `PaginationBar`, `CsvImportDialog`, `DownloadButton`, `EntityHistoryDialog`, `StatusBadge` — that's real reuse, not copy-paste.
- **Strategy pattern for approvals** (`lib/approvals/module-handlers.ts`) means the approve/reject route never changes when a module is added.
- **`withGateway`** gives every route one auth → access → Zod → handler path with a consistent error shape.
- **TypeScript discipline in the frontend is strong** — 13 `any` across 129 `.tsx` files.
- **Largest hand-written file is 648 lines.** For an ERP this is unusually well-contained.
- **The code comments are unusually good** — several (`Sidebar.tsx:111-117` on prefix-matching, `layout.tsx:14-27` on slug seeding) explain non-obvious *why*, not *what*. Keep writing those.
