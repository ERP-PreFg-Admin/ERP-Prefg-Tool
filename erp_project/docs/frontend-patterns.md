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
  const res = await fetch("/api/masters/skus", { method: "POST", body: ... });
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
| Search / filter | Client-side string match in `SearchInput` — filters the `initialData` array in state |
| Pagination | Not implemented — all rows are returned |
| Column sorting | Not implemented |

The client component holds the full dataset in memory and filters it on each search keystroke. This is acceptable for master data where row counts are in the hundreds, not millions.

### Splitting a Large Data Table

Once a table's row-renderer grows past a few hundred lines (row actions, a three-dot menu, several per-action dialogs), split it the way `app/po-tracking/po-procurement/PoTable.tsx` does rather than let one file keep growing:

| Piece | File | Responsibility |
|-------|------|----------------|
| Table shell | `PoTable.tsx` | Owns column layout, row mapping, `useState` for "which dialog is open," renders per-row action buttons |
| Reusable cell renderers | `PoTableCells.tsx` | Small presentational pieces used across rows/columns — e.g. `ProgressCell`, `SortHead` (a sortable `<TableHead>`) |
| Row-level overflow menu | `PoActionMenu.tsx` | Generic `{ label, icon, onClick, variant, disabled }[]` menu — the table builds the `actions` array per row, the menu only renders it |
| Per-action dialogs | `CancelPODialog.tsx`, `ReceivePODialog.tsx`, `ShortClosePODialog.tsx`, `SplitPODialog.tsx` | One dialog component per destructive/complex action, each owning its own form state and API call |

The table shell holds only the "which row is this dialog targeting" state (e.g. `const [cancelTarget, setCancelTarget] = useState<number | null>(null)`) and renders each dialog once, outside the `<table>`, controlled by that state — not one dialog instance per row. This keeps the table itself close to a plain row-mapping function and pushes all non-trivial logic into single-purpose files.

### Lifting Selection State to the Parent

For a Gmail-style "select rows across the whole table, then act on the selection" flow (see `PoProcurementClient.tsx` + `PoTable.tsx` + `PoSelectionBar.tsx`), selection state (`selectedIds: Set<number>`) lives in the parent client component, not the table:

```ts
// PoProcurementClient.tsx
const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
```

The table receives `selectedIds`, `onToggleRow`, `onToggleAll` as props and only renders checkboxes — it has no selection logic of its own. A separate floating bar component (`PoSelectionBar.tsx`) reads the same `selectedIds` (resolved to full rows by the parent) and renders the bulk action plus a review/confirm dialog. This mirrors the Server/Client split rule above: state that outlives a single component's render (here, state shared between the table and a floating bar) belongs one level up, not duplicated.

### History Dialogs

`EditHistoryDialog.tsx` (vendors, manufacturers), `RmRateHistoryDialog.tsx`, `PmRateHistoryDialog.tsx`, and `BomHistoryTable.tsx`/`BomHistoryClient.tsx` all share the same shape: a read-only `Dialog` that takes a nullable `row`/id prop (`null` closes it), fetches its own history rows from a dedicated `*-history` endpoint in a `useEffect` keyed on that prop, and renders a plain table of past values with a status badge per entry. There is no shared base component — each is a small, independent copy of the same pattern — but new "view history for X" dialogs should follow this shape rather than invent a new one.

## Font Setup

Four fonts are loaded via `next/font/google` in `app/layout.tsx`:

| CSS variable | Font | Usage |
|-------------|------|-------|
| `--font-geist-sans` | Geist | Sans-serif body text |
| `--font-geist-mono` | Geist Mono | Monospace / code |
| `--font-sans` | Roboto | Alternative sans-serif |
| `--font-heading` | Merriweather | Headings |

These variables are applied via Tailwind's `font-*` utilities or CSS `var(--font-*)` directly.

## Auth Pages Layout

Auth pages (`/auth/signin`, `/auth/error`, `/auth/unauthorized`) render without the sidebar or top bar. `ClientLayout.tsx` detects the `/auth` prefix in the pathname and returns `{children}` directly, bypassing the main layout chrome.
