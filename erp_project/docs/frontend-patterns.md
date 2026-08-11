# Frontend Patterns

> **Related docs:** [Architecture](./architecture.md) · [Masters Module](./masters-module.md) · [Adding a New Module](./adding-a-new-module.md)

This document describes the recurring patterns used across the frontend. Follow these when building new pages or components to stay consistent with the existing codebase.

## Server vs Client Component Split

**The rule:** Server Components fetch data and enforce authentication/authorisation. Client Components own interactivity (state, events, dialogs, optimistic UI).

| Concern | Component type | Why |
|---------|---------------|-----|
| Authentication check | Server | `auth()` is async and server-only |
| Permission check | Server | `resolveAccess()` queries the DB |
| Data fetching | Server | `lib/db.ts` is server-only (mysql2) |
| URL redirects | Server | `redirect()` from `next/navigation` |
| React state, `useState`, `useEffect` | Client | Requires the browser runtime |
| Event handlers, dialogs, forms | Client | Interactive DOM manipulation |
| `useRouter().refresh()` | Client | Triggers server re-fetch after mutation |

```ts
// app/masters/skus/page.tsx — Server Component (no "use client")
export default async function Page() {
  const session = await auth();
  const skus = await query<Sku>("SELECT ...");
  return <SkusClient initialSkus={skus} />;
}

// app/masters/skus/SkusClient.tsx — Client Component
"use client";
export function SkusClient({ initialSkus }: { initialSkus: Sku[] }) {
  const [search, setSearch] = useState("");
  // ...
}
```

## After a Mutation: Use `router.refresh()`

After a successful POST to an API route, call `router.refresh()` (not `router.push()`). This re-runs the Server Component's data fetch and updates the UI with fresh data from the database, without a full page reload.

```ts
import { useRouter } from "next/navigation";

const router = useRouter();

async function handleCreate(data: FormData) {
  const res = await fetch("/api/v1/masters/skus", { method: "POST", body: ... });
  if (res.ok) router.refresh(); // ← triggers server-side re-fetch
}
```

## Sidebar Navigation (`components/Sidebar.tsx`)

The `NAV` array inside `Sidebar.tsx` is the single source of truth for the navigation menu structure. To add a new menu item or submenu, add an entry to this array.

```ts
const NAV = [
  {
    label: "Masters",
    href: "/masters",
    icon: Database,
    children: [
      { label: "SKUs", href: "/masters/skus" },
      { label: "Vendors", href: "/masters/vendors" },
      // add new sub-pages here
    ],
  },
  // add new top-level modules here
];
```

Children render as a collapsible sub-list. Active state is determined by `pathname === href || pathname.startsWith(href + "/")`.

**Auth pages** (`/auth/*`) suppress the sidebar entirely — `ClientLayout.tsx` checks the pathname and renders only `{children}` without the layout chrome on auth routes.

## Styling Conventions

**Tailwind CSS v4** — CSS-first configuration. There is no `tailwind.config.js`. For most styling needs, use standard Tailwind utility classes directly.

**Component library:** `components/ui/` contains shadcn/ui components (Button, Input, Dialog, Table, Badge, Card, Tooltip, Label). Do not edit these files directly. To add a new component:
```bash
npx shadcn@latest add <component-name>
```

**`cn()` utility** — always use this for conditional or merged class names:
```ts
import { cn } from "@/lib/utils";

// Merges Tailwind classes correctly, resolving conflicts
<div className={cn("px-4 py-2", isActive && "bg-blue-500", className)}>
```

`cn()` wraps `clsx` (conditional class joining) and `tailwind-merge` (conflict resolution). Using string concatenation or template literals directly can produce duplicate or conflicting Tailwind classes.

**Design tokens** — CSS variables for colours, spacing, and typography are defined in `app/globals.css`. Sidebar colours (`--sidebar`, `--sidebar-foreground`, etc.) are customised there.

## Form and Dialog Pattern

Generic dialogs in `components/masters/` accept a `fields: MasterField[]` prop that declaratively defines the form:

```ts
type MasterField = {
  key: string;           // field name in the POST body
  label: string;         // display label
  type: "text" | "number" | "select";
  required?: boolean;
  placeholder?: string;
  options?: string[];    // for type: "select"
  colSpan?: 1 | 2;      // grid column span in the form layout
};
```

The dialog:
1. Renders a form from the field config
2. Validates `required` fields before submit
3. POSTs `{ action: "create", ...formValues }` to the `endpoint` prop
4. Shows the API error message inline on failure (not a toast/notification)
5. Calls `onSuccess()` on success (caller typically calls `router.refresh()`)

For entities that need custom forms (like Raw Materials' multi-step wizard), build a custom component that follows the same POST + `router.refresh()` pattern.

### Bulk CSV Import Dialog

`components/masters/CsvImportDialog.tsx` is the shared bulk-upload dialog, reused across vendors, manufacturers, RM/PM rates, material master, and BOM master. It takes a declarative `fields: MasterField[]` (same shape as the single-record form fields) plus an `endpoint`, and handles:

1. Client-side CSV parsing and preview (with per-row validation/remarks), or optional client-side `.xlsx` parsing via `previewExcel` (large Excel files fall back to an upload-to-S3-then-server-parses path)
2. An optional `enableDuplicateCheck` round-trip that POSTs `{ action: "check_duplicates", rows }` to `endpoint` and merges warnings into the preview
3. Downloadable CSV template (`downloadTemplate`) and a "download flagged rows" export for fixing invalid rows
4. Upload via `{ action: "bulk", rows: valid }` (or `bulk_from_s3` for the legacy Excel path); a response carrying `approval_id` means the whole batch was staged as one pending approval rather than inserted directly (bulk-approval masters), otherwise `{ inserted, skipped }` is shown

Use this component instead of building a new upload dialog whenever an entity needs CSV/Excel bulk import — extend `fields`/`endpoint` rather than forking the component.

## Table Rendering

All master tables are plain HTML `<table>` elements styled with Tailwind. The shadcn/ui `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell` components are wrappers around these.

| Feature | Current approach |
|---------|-----------------|
| Default sort order | Defined server-side in the SQL `ORDER BY` clause |
| Search / filter | **URL-driven** on paginated pages (`?search=`, `?status=`, … read in `page.tsx` and pushed into the SQL). Small in-memory lists (e.g. the admin Users table, tens of rows) still filter client-side in `SearchInput`. |
| Pagination | Server-side — `parsePaginationParams(searchParams)` + `PaginationBar`; only the visible slice is fetched |
| Column sorting | `components/ui/sortable-table-head.tsx` — `?sortBy=`/`?sortDir=` in the URL, resolved in SQL. The whole header cell is the button, with a faint chevron hinting that inactive columns are sortable. |

Rule of thumb: if the list can grow past a few hundred rows, filter and paginate in SQL through the URL (so the server re-runs the query and the state is shareable/back-button-safe). Only hold the full dataset in memory for lists that are structurally small.

### Shared UI primitives

Added to `components/ui/` — check here before writing a bespoke one:

| Component | Use |
|-----------|-----|
| `tabs.tsx` | `Tabs` / `TabsList` / `TabsTrigger`. `TabsTrigger` renders a `<button>`, so navigation tabs (e.g. `app/admin/AdminTabs.tsx`) mirror its styling on a `<Link>` instead |
| `callout.tsx` | Info / warning / success / destructive inline notice, light + dark |
| `stepper.tsx` | Numbered step indicator for wizards |
| `segmented-toggle.tsx` | Pill-style 2+ way toggle. Pass `getHref` for URL-driven views (the server re-renders with only the selected view's data fetched) or `onSelect` for plain client state. Replaced the four near-identical `ViewToggle`/`MaterialToggle` copies. |
| `sortable-table-head.tsx` | Sortable `<TableHead>` (see above) |
| `toggle-button.tsx` | `Button` with `aria-pressed` + a pressed look |
| `icon-action-button.tsx` | Bare icon-only row action (edit / compare / history) shared by every rate table's action column, with a muted non-interactive disabled state for rows locked by a pending approval |

### Splitting a Large Data Table

Once a table's row-renderer grows past a few hundred lines (row actions, a three-dot menu, several per-action dialogs), split it the way `app/po-tracking/po-procurement/PoTable.tsx` does rather than let one file keep growing:

| Piece | File | Responsibility |
|-------|------|----------------|
| Table shell | `PoTable.tsx` | Owns column layout, row mapping, `useState` for "which dialog is open," renders per-row action buttons |
| Reusable cell renderers | `PoTableCells.tsx` | Small presentational pieces used across rows/columns — e.g. `ProgressCell`, `SortHead` (a sortable `<TableHead>`) |
| Row-level overflow menu | `PoActionMenu.tsx` | Generic `{ label, icon, onClick, variant, disabled }[]` menu — the table builds the `actions` array per row, the menu only renders it |
| Per-action dialogs | `CancelPODialog.tsx`, `ReceivePODialog.tsx`, `ShortClosePODialog.tsx`, `SplitPODialog.tsx` | One dialog component per destructive/complex action, each owning its own form state and API call |

The table shell holds only the "which row is this dialog targeting" state (e.g. `const [cancelTarget, setCancelTarget] = useState<number | null>(null)`) and renders each dialog once, outside the `<table>`, controlled by that state — not one dialog instance per row. This keeps the table itself close to a plain row-mapping function and pushes all non-trivial logic into single-purpose files.

### One Card, Many Diff Shapes (`app/approvals/approval-card/`)

The approval card grew from "render a field diff" to "render whatever this module's change actually looks like". Rather than branching inside one component, it's split by *shape*:

| File | Renders |
|------|---------|
| `ApprovalCard.tsx` | The shell — module badge, entity info, expand/collapse, and dispatch to the right diff renderer |
| `ApprovalRow.tsx` | The condensed one-line row used inside a grouped section |
| `FieldDiffTable.tsx` / `DiffTable.tsx` | Ordinary field-level old→new diffs |
| `BomLineDiffTable.tsx` | BOM line changes, resolving bare `mtrl_id`s through a `MaterialMap` (rm/pm are independent id sequences and can collide, so the map is split by type) |
| `CsvDiff.tsx` | Bulk-upload file cards |
| `EntityInfo.tsx`, `DocViewButton.tsx`, `ApprovalActions.tsx` | Entity summary, attachment viewer, approve/reject buttons |

The queue itself groups by module (busiest first), folds each `*_BULK` module into its base module's group via `groupKeyFor`, then splits each group into **New** (every changed field has no prior value), **Edits**, and **Bulk Uploads** — so each reads as its own condensed section instead of one undifferentiated stack. Bulk files open in `CsvPreviewDialog`, which renders the file as a table via `GET /api/v1/files/preview` rather than handing a non-technical approver a raw CSV download.

`EntityHistoryDialog` reuses `ApprovalCard` read-only (`isApprover={false}`) instead of a second diff renderer — worth copying whenever a "show me this record's changes" surface appears.

### Lifting Selection State to the Parent

For a Gmail-style "select rows across the whole table, then act on the selection" flow (see `PoProcurementClient.tsx` + `PoTable.tsx` + `PoSelectionBar.tsx`), selection state (`selectedIds: Set<number>`) lives in the parent client component, not the table:

```ts
// PoProcurementClient.tsx
const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
```

The table receives `selectedIds`, `onToggleRow`, `onToggleAll` as props and only renders checkboxes — it has no selection logic of its own. A separate floating bar component (`PoSelectionBar.tsx`) reads the same `selectedIds` (resolved to full rows by the parent) and renders the bulk action plus a review/confirm dialog. This mirrors the Server/Client split rule above: state that outlives a single component's render (here, state shared between the table and a floating bar) belongs one level up, not duplicated.

### History Dialogs

The per-page copies are gone: `components/masters/EntityHistoryDialog.tsx` covers every master entity (reusing `ApprovalCard` read-only rather than a second diff renderer) and `components/masters/RateHistoryDialog.tsx` covers all four RM/PM × mfg/vendor rate histories. The shape is still the same — a read-only `Dialog` taking a nullable `row`/id prop (`null` closes it), fetching from a `*-history` endpoint in a `useEffect` keyed on that prop — but **reuse those two rather than copying the pattern again**.

### Streaming multi-step progress

When one submit runs several non-atomic steps (see the Add Invoice flow), don't fake a spinner: have the route return `application/x-ndjson` and emit one JSON object per step. `AddInvoiceDialog` reads the stream and turns each event into a toast + button label. The HTTP status is `200` as soon as streaming starts, so **the failure has to travel as an event** — the client must inspect `outcome.ok`, not just `res.ok`. Set `X-Accel-Buffering: no` or nginx buffers the whole body and defeats the point.

### Long-running work needs local recovery

For a form whose input cost is high (a ~60 s parse plus manual review), checkpoint it locally: `invoice-draft.ts` mirrors the review — **including the PDF `File`** — into **IndexedDB**, not localStorage, which holds ~5 MB of *strings* (a 10 MB PDF is ~13 MB base64'd). Every draft operation is best-effort: storage can be unavailable (private mode, blocked cookies, quota exhausted) and a draft that fails to save must never take the flow down with it.

### Drag-to-resize split panes (`useSplitPane`)

Pointer listeners live on `window`, not the handle, so the drag survives the pointer outrunning a few-pixel divider. The hook exposes `dragging` because the caller **must** disable pointer events on any `<iframe>` in either pane — an iframe swallows the pointer and the drag stalls halfway across.

## Font Setup

Four fonts are loaded via `next/font/google` in `app/layout.tsx`:

| CSS variable | Font | Usage |
|-------------|------|-------|
| `--font-geist-sans` | Geist | Sans-serif body text |
| `--font-geist-mono` | Geist Mono | Monospace / code |
| `--font-sans` | **Outfit** | Body sans-serif (`html { @apply font-sans }`) — replaced Roboto |
| `--font-heading` | Merriweather | Headings — now applied globally to `h1`–`h6` in `globals.css`, so headings don't need a `font-heading` class of their own |

## Auth Pages Layout

Auth pages (`/auth/signin`, `/auth/error`, `/auth/unauthorized`) render without the sidebar or top bar. `ClientLayout.tsx` detects the `/auth` prefix in the pathname and returns `{children}` directly, bypassing the main layout chrome.
