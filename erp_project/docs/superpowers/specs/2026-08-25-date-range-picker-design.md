# Shared Date Picker — dual-calendar range, app-wide — Design

**Date:** 2026-08-25
**Status:** awaiting approval

## Goal

Replace every `<input type="date">` in the app with **one reusable component** that
presents a flight-booking-style picker: two side-by-side month calendars, a hover
preview across the range, one control per date range.

The emphasis is **reuse**. This is not 17 pickers; it is one primitive with two
exports, dropped into 17 places. No call site gets its own calendar logic, its own
formatting, or its own popover.

## Current state

**23 native `<input type="date">` across 16 files**, which collapse to **17
controls** — the six From/To pairs each become one range control:

| Group | Shape | Inputs today | Controls after |
|---|---|---|---|
| **A** | Range filter on a list toolbar | 6 (3 pairs) | 3 |
| **B** | Validity window written to a record | 6 (3 pairs) | 3 |
| **C** | Genuinely single date | 11 | 11 |
| | | **23** | **17** |

Full inventory:

| Group | File | Line(s) | Field |
|---|---|---|---|
| A | `app/po-tracking/po-procurement/PoProcurementClient.tsx` | 378, 387 | Date From / Date To |
| A | `app/po-tracking/invoices/InvoicesClient.tsx` | 85, 89 | Invoice date from / to |
| A | `app/admin/activity/ActivityClient.tsx` | 103, 110 | From / To |
| B | `app/masters/raw-materials/EditRmVendorRateDialog.tsx` | 186, 193 | Effective From / To |
| B | `app/masters/packing-materials/EditPmVendorRateDialog.tsx` | 177, 184 | Effective From / To |
| B | `app/manufacturing/[mfgId]/MiscCostDialog.tsx` | 189, 196 | Effective From / Till |
| C | `components/masters/MaterialRateTable.tsx` | 472 | Effective From (vendor filter panel) |
| C | `components/masters/MaterialRateTable.tsx` | 521 | Effective From (mfg filter panel) |
| C | `app/masters/raw-materials/EditRmMfgRateDialog.tsx` | 164 | Effective From |
| C | `app/masters/packing-materials/EditPmMfgRateDialog.tsx` | 162 | Effective From |
| C | `app/po-tracking/po-procurement/ImpromptuPODialog.tsx` | 279 | Expected Dispatch |
| C | `app/po-tracking/po-procurement/AddPODialog.tsx` | 112 | Expected On (table cell) |
| C | `app/po-tracking/po-inwarding/InvoiceFields.tsx` | 108 | Invoice Date (via local `Field`) |
| C | `app/masters/recipe-master/RecipeWizardSteps.tsx` | 227 | Effective From |
| C | `app/masters/recipe-master/RecipeEditDialog.tsx` | 136 | Effective From |
| C | `app/masters/raw-materials/AddRawMaterialWizard.tsx` | 610 | Effective From (table cell) |
| C | `app/masters/packing-materials/AddPackingMaterialWizard.tsx` | 554 | Effective From (table cell) |

> `MaterialRateTable:472` and `:521` are **two separate single filters** (vendor panel
> and mfg panel), not a From/To pair. Easy to misread as group B.

## Approach chosen

**Build on the already-installed `@radix-ui/react-popover`. Zero new dependencies.**

Rejected: `react-day-picker` v9. It gives `mode="range"` + `numberOfMonths={2}` for
free and its keyboard/ARIA behaviour is better tested, but it is a new runtime
dependency (pulling `date-fns`) and theming it to this app's tokens means ~80 lines
of pure `classNames` overrides — more code written to fight an API than to draw a
month grid. `radix-ui` is already a dependency and already provides the hard parts
(portalling, focus trap, dismiss, ARIA wiring).

## Files added

### `lib/date-range.ts` — pure date math, no React

Separate file because `AGENTS.md` restricts unit tests to **pure** modules; anything
reaching `lib/db`, `lib/s3` or `lib/mail/mailer` throws at import without
credentials. This split is what makes the logic testable in CI.

```ts
monthMatrix(year, month): (string | null)[][]   // 6×7 grid of ISO dates, null = padding
parseIso(iso): { y, m, d } | null
formatDisplay(iso): string                       // "25 Aug 2026"
isInRange(iso, from, to): boolean                // inclusive both ends
addMonths(year, month, delta): { year, month }
isBefore(a, b): boolean
```

**Critical:** `parseIso` splits on `-`. It must never call `new Date("2026-08-25")` —
a bare ISO date string parses as **UTC midnight**, and every display path in this app
is IST. That is the classic silent off-by-one-day bug, and the reason this is a
function rather than an inline expression at 17 call sites.

### `components/ui/date-picker.tsx` — the reusable component

```tsx
import { Popover } from "radix-ui"   // umbrella namespace import, per dialog.tsx / tooltip.tsx / button.tsx

export function DatePicker({
  value, onChange, min, max, placeholder, disabled, id, className,
}: {
  value: string                       // "yyyy-mm-dd" | ""
  onChange: (iso: string) => void
  min?: string
  max?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
})

export function DateRangePicker({
  from, to, onChange, min, max, allowOpenEnded, placeholder, disabled, className,
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  min?: string
  max?: string
  /** Renders "→ Ongoing" and permits an empty `to`. For open-ended validity windows. */
  allowOpenEnded?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
})
```

Both render one shared internal `<MonthGrid>`; `DatePicker` shows one month,
`DateRangePicker` shows two. There is no third export and no `mode` prop — the two
call shapes are genuinely different (one value vs two) and collapsing them would
force every caller to discriminate a union.

**The reuse contract:**

- **String in, string out.** Values are `yyyy-mm-dd`, exactly what
  `e.target.value` gave before. No `Date` objects cross the boundary, no timezone
  conversion, no parsing at the call site.
- **Drop-in for `<Input type="date">`.** Every call site keeps the state it has
  today. No payload, Zod schema, approval-diff or SQL change anywhere in this work.
- **No call-site branches inside the component.** Nothing named after a page or a
  module. If a site needs different behaviour it passes a prop.
- Trigger styling reuses the `Input` classes from `components/ui/input.tsx` so a
  closed picker is pixel-identical to the inputs beside it.

## Interaction

```
┌──────────────────────────────────┐
│ 01 Aug 2026  →  25 Aug 2026    ▾ │
└──────────────────────────────────┘
   ┌─────────────────┬─────────────────┐
   │ ‹    Aug 2026   │    Sep 2026   › │
   │ M T W T F S S   │ M T W T F S S   │
   │         1 2 3   │    1 2 3 4 5 6  │
   │ 4 5 6 7 8 9 …   │ …               │
   │ ▓▓▓▓▓ range ▓▓▓ │ ▓▓              │
   └─────────────────┴─────────────────┘
```

- Two months side by side; **one chevron pair moves both**, keeping them adjacent.
- First click sets `from` and arms the hover preview. Second click sets `to`.
- Clicking a date **before** `from` restarts the selection rather than committing an
  inverted range.
- `allowOpenEnded` renders `→ Ongoing` for an empty `to` and offers a "No end date"
  action in the footer.
- Escape and outside-click close (Radix). Arrow keys move the focused day, Enter
  picks, Tab leaves the grid.
- Popover **portals to body** — `AddPODialog`, `AddRawMaterialWizard` and
  `AddPackingMaterialWizard` put the input inside an `overflow-auto` table cell,
  which is the exact clipping problem `FuzzySelect` had to solve with a portal.
  Radix does it by default, so none of that measure-and-flip logic is re-derived.

## Call-site changes

| Group | Change |
|---|---|
| A (3 files) | Two `Input`s → one `DateRangePicker`. Component state unchanged. |
| B (3 files) | Two labelled fields → one `DateRangePicker` with `allowOpenEnded`. The pair gets one label ("Effective Period") carrying the required asterisk; the individual field labels go. State stays two variables, so the per-field approval diff is untouched. |
| C (9 files, 10 inputs) | `<Input type="date">` → `<DatePicker>`, same props. `MaterialRateTable` has two. |
| C (`InvoiceFields`) | One `type === "date"` branch in the local `Field` wrapper at line 19 — covers the site without touching the call at line 108. |

**Constraints preserved:** `min={today}` on `AddPODialog:112`,
`ImpromptuPODialog:279`, `EditRmVendorRateDialog:186`, `EditPmVendorRateDialog:177`.
`disabled={!canEdit}` on all four rate dialogs. `MiscCostDialog`'s Effective Till
stays optional via `allowOpenEnded`.

## Testing

`tests/unit/date-range.test.ts` — `node:test` + `node:assert/strict`, pure, runs in
CI under `npm test`:

1. `monthMatrix` on a leap February (2028-02) and a month starting Sunday.
2. `parseIso("2026-08-25")` returns day 25 — the IST/UTC off-by-one guard.
3. `isInRange` inclusive at both endpoints.
4. `isBefore` drives the inverted-range restart.
5. `formatDisplay("")` returns `""`, not "Invalid Date".

Gate before handing back: `npm test`, `npm run lint:changed`,
`npx tsc --noEmit --incremental false`.

## Explicitly not doing

- **Presets** ("Last 7 days", "This month"). Not asked for. The most likely
  follow-up request, and cheap to add later on the three group-A toolbars only.
- Time-of-day, locale switching, month/year dropdown jumping, multi-range selection.
