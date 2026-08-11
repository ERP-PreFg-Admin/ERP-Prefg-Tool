# PO Inwarding (replaces Dispatch Calendar) — Design

**Date:** 2026-07-31
**Status:** awaiting approval

## Goal

Replace the "Dispatch Calendar" stub under Production Tracking with a **PO Inwarding**
page: the same table view as FG POs Tracking, but focused on recording goods receipt
against open POs.

## Current state

| Thing | Where | Status |
|---|---|---|
| Dispatch Calendar page | `app/po-tracking/dispatch-calendar/page.tsx` | Stub — "🚧 Coming soon" card, auth gate only |
| Sidebar entry | `components/Sidebar.tsx:45` | `{ label: "Dispatch Calendar", href: "/po-tracking/dispatch-calendar" }` |
| Permission slug list | `app/layout.tsx:33` | `/po-tracking/dispatch-calendar` |
| FG POs Tracking page | `app/po-tracking/po-procurement/` | Live — server fetch + `PoProcurementClient` + `PoTable` |
| Receive dialog | `app/po-tracking/po-procurement/ReceivePODialog.tsx` | **Already built and working** |
| Receive API | `app/api/v1/purchase-orders/[id]/receive/route.ts` | **Already built** — row-locked, tolerance-based auto-close, history row, event log |

So the receiving mechanics need **no new backend work**. This is a page + view change.

## Approach chosen

Three options were on the table:

1. **Reuse `PoProcurementClient` + `PoTable` behind a `mode` flag** ← chosen
   ~6 conditionals in one existing file, no duplicated markup, and the two views stay
   pixel-identical where they overlap (which is the actual requirement).
2. New `PoInwardingClient` + `PoInwardingTable` — ~450 lines copy-pasted from files that
   are actively changing. Guaranteed to drift. Rejected.
3. Reuse the whole FG client unchanged — identical page at two URLs, including Add PO /
   CSV import / Entity Emails, which don't belong on an inwarding screen. Rejected.

## What the page looks like

```
Summary cards:  Total POs | Raised | Punched | Partially Received | Value of Open POs
Toolbar:        [ Search PO, SKU, MFG… ]  [ Filters ]
Tabs:           Open | Raised | Punched | Partially Received | Received | Short Closed | All
Table:          PO No · Manufacturer · PO Date · Exp. Dispatch · SKU · PO Qty · Received ·
                Rate · Amount · Invoice No · Destination · Status · [ Receive ] [⋮]
Pagination:     same PaginationBar
```

**Landing state:** the **Open** tab (`raised` + `punched` + `partially_received`) — the POs
actually awaiting inwarding. Everything else is one click away.

**Not on this page** (vs FG POs Tracking): Add PO, CSV bulk import, Entity Emails, the
row-select checkbox column, the send-mail selection bar, Edit, Split, Cancel PO.

**Row actions:** a labelled `Receive` button (opens the existing `ReceivePODialog`, shown
only for `raised` / `punched` / `partially_received`), plus the ⋮ menu limited to
**History**, **Review PDF**, and **Short Close** — short close belongs here because that's
the desk that discovers goods arrived short.

## Changes, file by file

1. **`git mv app/po-tracking/dispatch-calendar app/po-tracking/po-inwarding`**
   New `page.tsx` = a copy of `po-procurement/page.tsx`'s server fetch (same
   `buildSelectPaginated` / `countPaginated` / `statusCounts` / `summaryStats` /
   `getPoDropdownOptions` calls, same searchParams parsing), with:
   - `status` defaulting to `"open"` when the URL has no `status` param
   - heading "PO Inwarding" / "Record goods received against open purchase orders."
   - renders `<PoProcurementClient mode="inwarding" … />`

2. **`components/Sidebar.tsx:45`** — `{ label: "PO Inwarding", href: "/po-tracking/po-inwarding" }`

3. **`app/layout.tsx:33`** — slug `/po-tracking/dispatch-calendar` → `/po-tracking/po-inwarding`.
   No DB seeding: `resolveAccess`'s parent-slug fallback means it inherits `/po-tracking`.

4. **`lib/queries/purchase-orders.ts`** — the status filter is currently a 2-slot IN list
   (`IN (?, ?)`, so the `received` tab can also pull `short_closed`). The **Open** tab needs
   three values, so:
   - `FULL_WHERE`: `IN (?, ?)` → `IN (?, ?, ?)`
   - `statusMatchValues(status)` returns a 3-tuple: `open` → `["raised","punched","partially_received"]`,
     `received` → `["received","short_closed","short_closed"]`, anything else → the value ×3
     (padding is harmless inside an `IN` list)
   - `buildFilterParams` returns 22 elements instead of 21; update the param-count comments
     in the file's docblocks. Both pages and the export route call this same builder, so
     they stay in sync automatically.

5. **`po-procurement/po-types.ts`** — add `INWARD_TABS` (`open`, `raised`, `punched`,
   `partially_received`, `received`, `short_closed`) and an `open` entry in `STATUS_CONFIG`
   (label "Open", variant `secondary`) so the tab bar and any badge render it.

6. **`po-procurement/PoTable.tsx`** — two optional props, both defaulting to today's
   behaviour so the FG page's call site is untouched:
   - `selectable = true` → when false, drop the checkbox `<TableHead>`/`<TableCell>` and the
     `colSpan` on the empty row goes 14 → 13
   - `receiveOnly = false` → when true, hide Edit / Split / Cancel, render Receive as a
     labelled button instead of an icon, keep History / Review PDF / Short Close

7. **`po-procurement/PoProcurementClient.tsx`** — add `mode?: "procurement" | "inwarding"`
   (default `"procurement"`). When `"inwarding"`: hide CSV Import / Entity Emails / Add PO,
   use `INWARD_TABS`, pass `selectable={false} receiveOnly`, and skip rendering
   `AddPODialog` / `ImpromptuPODialog` / `SplitPODialog` / `PoSelectionBar`. Filters,
   search, summary cards, sorting and pagination are shared as-is.

8. **`docs/README.md:40`** — status row updated to `PO Tracking — PO Inwarding | Live | app/po-tracking/po-inwarding/`.
   `docs/discovery-full.md` and `docs/interaction-logging-map.md` mention the old stub in
   "not covered" notes; those get a one-line correction each.

## Not doing

- No calendar view (the old stub's promise). If a dispatch calendar is still wanted later
  it's a separate page.
- No changes to the receive API, tolerance math, or `partially_received` derivation — the
  computed `EFFECTIVE_STATUS_EXPR` already handles partial receipt without a status write.
- No invoice-number or receipt-date capture in the Receive dialog. The dialog takes qty
  only today; adding fields is a separate ask.
- No new permission row. Inherits `/po-tracking`; the receive API already gates on
  `{ pageSlug: "/po-tracking", level: "editor" }`.

## Verification

- `scripts/_check-po-status-filter.ts` — a ~15-line `assert` script (run with `npx tsx`):
  `buildFilterParams(...)` returns 22 elements, `status="open"` produces the three open
  statuses in the IN slots, `status="received"` still pairs with `short_closed`, and a
  plain status repeats itself. This is the one piece of real logic in the change.
- `npm run build` and `npm run lint` clean.
- Manual: open `/po-tracking/po-inwarding`, confirm it lands on Open, Receive a partial qty
  on a `raised` PO → row flips to Partially Received with the progress cell updated, receive
  the remainder → flips to Received. Confirm FG POs Tracking is visually unchanged.

## Risk

One shared file carries real risk: `lib/queries/purchase-orders.ts`. The param-array length
change affects FG POs Tracking and the PO export. Both go through `buildFilterParams`, so a
mismatch would be a hard mysql2 error on first load, not silent bad data — and the assert
script catches it before the build.
