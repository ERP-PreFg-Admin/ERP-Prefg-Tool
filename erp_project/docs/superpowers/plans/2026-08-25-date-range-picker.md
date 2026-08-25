# Shared Date Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 23 native `<input type="date">` in the app with one reusable component that shows two side-by-side month calendars for range selection.

**Architecture:** Pure calendar math is appended to the existing `lib/date.ts` (which already owns IST date questions and is import-safe for unit tests). One new client component, `components/ui/date-picker.tsx`, exports `DatePicker` (one month) and `DateRangePicker` (two months) over a shared internal `CalendarBody`. Both speak `yyyy-mm-dd` strings in and out, so every call site keeps the state it has today and no API payload, Zod schema, approval diff or SQL changes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, `radix-ui` (umbrella package — already a dependency), `lucide-react`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-25-date-range-picker-design.md`

## Global Constraints

- **Zero new dependencies.** Do not `npm install` anything. Popover comes from the already-installed `radix-ui` umbrella package.
- **Import Radix as a namespace from the umbrella package:** `import { Popover } from "radix-ui"` — matching `components/ui/dialog.tsx:4`, `tooltip.tsx:4`, `button.tsx:3`. Never `@radix-ui/react-popover` directly.
- **Never parse a date string with `new Date(iso)`.** A bare `"2026-08-25"` parses as UTC midnight; every display path in this app is IST. Use `parseIso`. Where a `Date` is unavoidable, construct from `Date.UTC(...)` components and read with `getUTC*`.
- **Reuse `todayIST()` from `lib/date.ts`.** Do not write a second "today" function.
- **Values are `yyyy-mm-dd` strings** at every component boundary. No `Date` object crosses in or out.
- **No call-site-specific logic inside the component.** Nothing named after a page or module. A site needing different behaviour passes a prop.
- Unit tests import **pure** modules only, via **relative** paths (`../../lib/date`). Anything reaching `lib/db`, `lib/s3` or `lib/mail/mailer` throws at import without credentials.
- Preserve at every migrated call site: its existing `className`, `disabled`, `min`, `id`, and any sibling validation JSX.
- Verification gate: `npm test`, `npm run lint:changed`, `npx tsc --noEmit --incremental false` (the `--incremental false` matters — a stale `tsconfig.tsbuildinfo` makes a plain `tsc --noEmit` report clean on a file `next build` then rejects).
- `npm run build` will not start while `npm run dev` is running; Next 16 holds one lock on `.next`.

---

### Task 1: Calendar math in `lib/date.ts`

**Files:**
- Modify: `lib/date.ts` (append; do not touch lines 1–55)
- Test: `tests/unit/date-calendar.test.ts` (create)

**Interfaces:**
- Consumes: `todayIST()` — already exported from `lib/date.ts:38`.
- Produces, all from `lib/date.ts`:
  - `WEEKDAYS: readonly string[]` — 7 Monday-first labels
  - `parseIso(iso: string): { y: number; m: number; d: number } | null`
  - `toIso(y: number, m: number, d: number): string`
  - `daysInMonth(y: number, m: number): number`
  - `monthMatrix(y: number, m: number): (string | null)[][]` — 6 rows × 7 cols
  - `addMonths(y: number, m: number, delta: number): { y: number; m: number }`
  - `anchorMonth(...candidates: string[]): { y: number; m: number }`
  - `monthLabel(y: number, m: number): string`
  - `formatDisplay(iso: string): string`
  - `isBefore(a: string, b: string): boolean`
  - `isInRange(iso: string, from: string, to: string): boolean`
  - `isDisabledDate(iso: string, min?: string, max?: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/date-calendar.test.ts`:

```ts
// Calendar grid math for the shared date picker.
//
// The interesting cases are all boundaries: a leap February, a month whose 1st
// falls on the Monday-first week edge, and the ISO parse that must NOT go
// through `new Date(str)` (UTC midnight, which reads back as the previous day
// anywhere east of Greenwich — the same bug lib/date.ts exists to kill).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  WEEKDAYS, parseIso, toIso, daysInMonth, monthMatrix, addMonths,
  anchorMonth, monthLabel, formatDisplay, isBefore, isInRange, isDisabledDate,
} from "../../lib/date"

test("parseIso reads the calendar day, not a UTC instant", () => {
  // The witness for what this replaces: `new Date("2026-08-25")` is UTC
  // midnight, so reading it back with local getters returns the 24th anywhere
  // west of Greenwich, and the wrong month at a month boundary.
  assert.deepEqual(parseIso("2026-08-25"), { y: 2026, m: 8, d: 25 })
  assert.deepEqual(parseIso("2026-01-01"), { y: 2026, m: 1, d: 1 })
  assert.deepEqual(parseIso("2026-12-31"), { y: 2026, m: 12, d: 31 })
})

test("parseIso rejects empty and malformed input instead of guessing", () => {
  for (const bad of ["", "2026-8-25", "25-08-2026", "2026-13-01", "2026-02-30", "garbage"]) {
    assert.equal(parseIso(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})

test("toIso zero-pads", () => {
  assert.equal(toIso(2026, 8, 5), "2026-08-05")
  assert.equal(toIso(2026, 12, 25), "2026-12-25")
})

test("daysInMonth handles leap years", () => {
  assert.equal(daysInMonth(2028, 2), 29)   // leap
  assert.equal(daysInMonth(2026, 2), 28)   // not leap
  assert.equal(daysInMonth(2000, 2), 29)   // century leap
  assert.equal(daysInMonth(1900, 2), 28)   // century non-leap
  assert.equal(daysInMonth(2026, 8), 31)
  assert.equal(daysInMonth(2026, 4), 30)
})

test("monthMatrix is always 6x7 so the popover height never jumps", () => {
  for (const [y, m] of [[2026, 8], [2028, 2], [2026, 2], [2026, 11]] as const) {
    const grid = monthMatrix(y, m)
    assert.equal(grid.length, 6, `${y}-${m} row count`)
    for (const row of grid) assert.equal(row.length, 7, `${y}-${m} col count`)
  }
})

test("monthMatrix pads the lead-in and lists every day exactly once", () => {
  // 1 Aug 2026 is a Saturday, so Monday-first leaves 5 leading nulls.
  const aug = monthMatrix(2026, 8).flat()
  assert.equal(aug.slice(0, 5).every((c) => c === null), true, "5 leading nulls")
  assert.equal(aug[5], "2026-08-01")
  const days = aug.filter(Boolean)
  assert.equal(days.length, 31)
  assert.equal(days[0], "2026-08-01")
  assert.equal(days[30], "2026-08-31")
  assert.equal(new Set(days).size, 31, "no duplicated day")
})

test("monthMatrix handles a month starting exactly on Monday", () => {
  // 1 Jun 2026 is a Monday — zero padding, the off-by-one-prone case.
  const jun = monthMatrix(2026, 6).flat()
  assert.equal(jun[0], "2026-06-01")
})

test("addMonths crosses year boundaries in both directions", () => {
  assert.deepEqual(addMonths(2026, 12, 1), { y: 2027, m: 1 })
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 })
  assert.deepEqual(addMonths(2026, 8, 0), { y: 2026, m: 8 })
  assert.deepEqual(addMonths(2026, 8, 5), { y: 2027, m: 1 })
  assert.deepEqual(addMonths(2026, 3, -14), { y: 2025, m: 1 })
})

test("anchorMonth takes the first parseable candidate, else today", () => {
  assert.deepEqual(anchorMonth("2026-08-25"), { y: 2026, m: 8 })
  assert.deepEqual(anchorMonth("", "2027-03-01"), { y: 2027, m: 3 })
  // No usable candidate must still yield a month to render, never null.
  const fallback = anchorMonth("", "")
  assert.equal(typeof fallback.y, "number")
  assert.equal(fallback.m >= 1 && fallback.m <= 12, true)
})

test("formatDisplay is empty for empty, never 'Invalid Date'", () => {
  assert.equal(formatDisplay(""), "")
  assert.equal(formatDisplay("garbage"), "")
  assert.equal(formatDisplay("2026-08-25"), "25 Aug 2026")
  assert.equal(formatDisplay("2026-01-05"), "05 Jan 2026")
})

test("monthLabel", () => {
  assert.equal(monthLabel(2026, 8), "Aug 2026")
})

test("isBefore compares ISO strings lexicographically", () => {
  assert.equal(isBefore("2026-08-01", "2026-08-25"), true)
  assert.equal(isBefore("2026-08-25", "2026-08-01"), false)
  assert.equal(isBefore("2026-08-25", "2026-08-25"), false)
  // An empty end is not "before" anything — it means unset.
  assert.equal(isBefore("", "2026-08-25"), false)
  assert.equal(isBefore("2026-08-25", ""), false)
})

test("isInRange is inclusive at both ends", () => {
  assert.equal(isInRange("2026-08-01", "2026-08-01", "2026-08-25"), true, "start")
  assert.equal(isInRange("2026-08-25", "2026-08-01", "2026-08-25"), true, "end")
  assert.equal(isInRange("2026-08-10", "2026-08-01", "2026-08-25"), true, "middle")
  assert.equal(isInRange("2026-07-31", "2026-08-01", "2026-08-25"), false, "before")
  assert.equal(isInRange("2026-08-26", "2026-08-01", "2026-08-25"), false, "after")
  // A half-open selection has no range to be inside yet.
  assert.equal(isInRange("2026-08-10", "2026-08-01", ""), false)
})

test("isDisabledDate respects min/max, unbounded when absent", () => {
  assert.equal(isDisabledDate("2026-08-01", "2026-08-15"), true)
  assert.equal(isDisabledDate("2026-08-20", "2026-08-15"), false)
  assert.equal(isDisabledDate("2026-09-01", undefined, "2026-08-31"), true)
  assert.equal(isDisabledDate("2026-08-15", "2026-08-15"), false, "min is inclusive")
  assert.equal(isDisabledDate("2026-08-31", undefined, "2026-08-31"), false, "max is inclusive")
  assert.equal(isDisabledDate("2026-08-20"), false, "no bounds")
})

test("WEEKDAYS is Monday-first and 7 long", () => {
  assert.equal(WEEKDAYS.length, 7)
  assert.equal(WEEKDAYS[0], "Mo")
  assert.equal(WEEKDAYS[6], "Su")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/date-calendar.test.ts`

Expected: FAIL — the import of `WEEKDAYS`, `parseIso`, etc. from `../../lib/date` does not resolve those names yet.

- [ ] **Step 3: Append the implementation to `lib/date.ts`**

Add to the **end** of `lib/date.ts`, leaving the existing `IST` / `todayIST` / `monthIST` / `SQL_TODAY_IST` block untouched:

```ts
// ── Calendar grid math, for components/ui/date-picker.tsx ────────────────────
//
// Lives here rather than in a `lib/date-range.ts` because a second date module
// would mean two answers to "what is today", which is the exact failure this
// file's header warns about. `todayIST` above is reused, not re-implemented.

/** Monday-first: the picker is for an Indian business week. */
export const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

/**
 * `"2026-08-25"` → `{ y: 2026, m: 8, d: 25 }`; `null` for empty or malformed.
 *
 * Splits the string rather than calling `new Date(iso)`: a bare ISO date parses
 * as UTC *midnight*, so reading it back with local getters returns the previous
 * day for anyone west of Greenwich, and the wrong month at a month boundary.
 * Same class of bug as the one documented at the top of this file.
 */
export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "")
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12) return null
  if (d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

export function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/**
 * Day 0 of month `m + 1` is the last day of month `m`. `m` is 1-based here and
 * 0-based in `Date`, so passing `m` already means "the following month".
 * Built from explicit UTC components and read with `getUTCDate` — no string
 * parsing, so no timezone can shift it.
 */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Monday-first weekday index (0 = Mon … 6 = Sun) of the 1st of the month. */
function firstWeekdayMondayFirst(y: number, m: number): number {
  const sundayFirst = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  return (sundayFirst + 6) % 7
}

/**
 * One month as 6 rows × 7 columns of ISO dates; `null` is padding either side.
 *
 * Always 6 rows even when 5 would fit, so the popover does not change height as
 * you page through months — a jumping popover moves the day you were aiming at
 * out from under the cursor.
 */
export function monthMatrix(y: number, m: number): (string | null)[][] {
  const lead = firstWeekdayMondayFirst(y, m)
  const cells: (string | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: daysInMonth(y, m) }, (_, i) => toIso(y, m, i + 1)),
  ]
  while (cells.length < 42) cells.push(null)
  return Array.from({ length: 6 }, (_, r) => cells.slice(r * 7, r * 7 + 7))
}

/** Month arithmetic in a flat month-count, so year rollover is not a special case. */
export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const flat = y * 12 + (m - 1) + delta
  return { y: Math.floor(flat / 12), m: (flat % 12) + 1 }
}

/**
 * Which month the calendar should open on: the first parseable candidate
 * (current value, then `min`), falling back to today in IST. Never null — the
 * picker always has a month to render.
 */
export function anchorMonth(...candidates: string[]): { y: number; m: number } {
  for (const c of candidates) {
    const p = parseIso(c)
    if (p) return { y: p.y, m: p.m }
  }
  const t = parseIso(todayIST())
  return t ? { y: t.y, m: t.m } : { y: 1970, m: 1 }
}

export function monthLabel(y: number, m: number): string {
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** `"2026-08-25"` → `"25 Aug 2026"`. `""` for anything unparseable — a trigger
 *  reading "Invalid Date" is worse than one reading its placeholder. */
export function formatDisplay(iso: string): string {
  const p = parseIso(iso)
  return p ? `${String(p.d).padStart(2, "0")} ${MONTH_NAMES[p.m - 1]} ${p.y}` : ""
}

/** ISO dates sort lexicographically, so string compare is a correct date compare.
 *  An empty operand means "unset", which is never before or after anything. */
export function isBefore(a: string, b: string): boolean {
  return Boolean(a) && Boolean(b) && a < b
}

/** Inclusive at both ends. A half-open selection (`to` empty) contains nothing. */
export function isInRange(iso: string, from: string, to: string): boolean {
  if (!iso || !from || !to) return false
  return iso >= from && iso <= to
}

/** Outside `[min, max]` — both inclusive, both optional. */
export function isDisabledDate(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min) return true
  if (max && iso > max) return true
  return false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`

Expected: PASS — the new `date-calendar` tests plus every pre-existing unit test, including `date-ist.test.ts` (which must be unaffected: nothing above line 56 of `lib/date.ts` changed).

- [ ] **Step 5: Type-check and lint**

```bash
npx tsc --noEmit --incremental false
npm run lint:changed
```

Expected: clean on both new/changed files.

- [ ] **Step 6: Commit**

```bash
git add lib/date.ts tests/unit/date-calendar.test.ts
git commit -m "feat(date): calendar grid math for the shared picker"
```

---

### Task 2: The reusable component

**Files:**
- Create: `components/ui/date-picker.tsx`

**Interfaces:**
- Consumes from `@/lib/date` (Task 1): `WEEKDAYS`, `parseIso`, `monthMatrix`, `addMonths`, `anchorMonth`, `monthLabel`, `formatDisplay`, `isBefore`, `isInRange`, `isDisabledDate`.
- Consumes `cn` from `@/lib/utils`; `Popover` from `radix-ui`; `ChevronLeft`, `ChevronRight`, `CalendarDays` from `lucide-react`.
- Produces, both from `@/components/ui/date-picker`:

```ts
DatePicker(props: {
  value: string                                    // "yyyy-mm-dd" | ""
  onChange: (iso: string) => void
  min?: string
  max?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
}): JSX.Element

DateRangePicker(props: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  min?: string
  max?: string
  allowOpenEnded?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}): JSX.Element
```

- [ ] **Step 1: Create the component**

Create `components/ui/date-picker.tsx`:

```tsx
"use client"

import { useState, type KeyboardEvent, type ReactNode } from "react"
import { Popover } from "radix-ui"
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WEEKDAYS, monthMatrix, addMonths, anchorMonth, monthLabel,
  formatDisplay, isBefore, isInRange, isDisabledDate,
} from "@/lib/date"

/**
 * The app's one date picker: `DatePicker` for a single date, `DateRangePicker`
 * for a from/to pair shown as two side-by-side months with a hover preview.
 *
 * Both are drop-in replacements for `<Input type="date">` — they take and give
 * back "yyyy-mm-dd" strings, exactly what `e.target.value` gave, so a call site
 * changes its markup and nothing else. No Date object crosses this boundary.
 *
 * Built on Radix Popover rather than a hand-rolled dropdown because it portals
 * to body, which is what stops the calendar being clipped inside the
 * `overflow-auto` table cells in AddPODialog and both material wizards — the
 * problem components/ui/FuzzySelect.tsx had to solve by hand.
 */

/** Mirrors the trigger to components/ui/input.tsx so a closed picker is
 *  pixel-identical to the inputs beside it. */
const TRIGGER_CLASS =
  "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 py-1 text-left text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

const POPOVER_CLASS =
  "z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"

const NAV_CLASS =
  "grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function MonthGrid({
  y, m, selected, from, to, min, max, onPick, onHover,
}: {
  y: number
  m: number
  /** Single-date mode: the one chosen day. */
  selected?: string
  /** Range mode: the committed or in-progress start. */
  from?: string
  /** Range mode: the end, or the hovered day while the range is half-open. */
  to?: string
  min?: string
  max?: string
  onPick: (iso: string) => void
  onHover?: (iso: string) => void
}) {
  return (
    <div className="w-[15.75rem]">
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="grid h-7 place-items-center text-[0.6875rem] font-medium text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      {monthMatrix(y, m).map((week, wi) => (
        <div key={wi} className="grid grid-cols-7">
          {week.map((iso, di) => {
            if (!iso) return <div key={di} className="h-8" />
            const disabled = isDisabledDate(iso, min, max)
            const isEnd = iso === selected || iso === from || iso === to
            const inside = isInRange(iso, from ?? "", to ?? "") && !isEnd
            return (
              <button
                key={di}
                type="button"
                data-iso={iso}
                disabled={disabled}
                aria-label={formatDisplay(iso)}
                aria-current={isEnd ? "date" : undefined}
                onClick={() => onPick(iso)}
                onMouseEnter={() => onHover?.(iso)}
                className={cn(
                  "h-8 rounded-md text-sm tabular-nums transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-30",
                  isEnd && "bg-primary font-medium text-primary-foreground",
                  inside && "bg-accent",
                  !isEnd && !disabled && "hover:bg-accent",
                )}
              >
                {Number(iso.slice(8, 10))}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Header chevrons + one or two grids + optional footer.
 *
 * One chevron pair drives both months so they stay adjacent — two independent
 * pairs let a user put August next to next March, which makes a range
 * selection across the gap read as a much shorter span than it is.
 */
function CalendarBody({
  months, view, onView, footer, ...grid
}: {
  months: 1 | 2
  view: { y: number; m: number }
  onView: (next: { y: number; m: number }) => void
  footer?: ReactNode
  selected?: string
  from?: string
  to?: string
  min?: string
  max?: string
  onPick: (iso: string) => void
  onHover?: (iso: string) => void
}) {
  const right = addMonths(view.y, view.m, 1)

  // Arrow keys move the focused day. ponytail: clamps at the edge of the
  // rendered months instead of paging the view — page with the chevrons.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
    }
    const delta = step[e.key]
    if (!delta) return
    e.preventDefault()
    const cells = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-iso]:not(:disabled)")
    )
    const at = cells.indexOf(document.activeElement as HTMLButtonElement)
    const next = at < 0 ? 0 : Math.min(Math.max(at + delta, 0), cells.length - 1)
    cells[next]?.focus()
  }

  return (
    <div onKeyDown={onKeyDown}>
      <div className="mb-1 flex items-center justify-between">
        <button
          type="button"
          className={NAV_CLASS}
          aria-label="Previous month"
          onClick={() => onView(addMonths(view.y, view.m, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex flex-1 justify-around text-sm font-medium">
          <span>{monthLabel(view.y, view.m)}</span>
          {months === 2 && <span>{monthLabel(right.y, right.m)}</span>}
        </div>
        <button
          type="button"
          className={NAV_CLASS}
          aria-label="Next month"
          onClick={() => onView(addMonths(view.y, view.m, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="flex gap-4">
        <MonthGrid y={view.y} m={view.m} {...grid} />
        {months === 2 && <MonthGrid y={right.y} m={right.m} {...grid} />}
      </div>
      {footer}
    </div>
  )
}

export function DatePicker({
  value, onChange, min, max, placeholder = "Select date", disabled, id, className,
}: {
  value: string
  onChange: (iso: string) => void
  min?: string
  max?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => anchorMonth(value, min ?? ""))

  // Re-anchor on open rather than syncing in an effect: `value` often arrives
  // after mount (async record load), and opening is the only moment the month
  // actually has to be right.
  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) setView(anchorMonth(value, min ?? ""))
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button id={id} type="button" disabled={disabled} className={cn(TRIGGER_CLASS, className)}>
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {formatDisplay(value) || placeholder}
          </span>
          <CalendarDays className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className={POPOVER_CLASS}>
          <CalendarBody
            months={1}
            view={view}
            onView={setView}
            selected={value}
            min={min}
            max={max}
            onPick={(iso) => {
              onChange(iso)
              setOpen(false)
            }}
            footer={
              value ? (
                <button
                  type="button"
                  className="mt-2 w-full rounded-md py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    onChange("")
                    setOpen(false)
                  }}
                >
                  Clear
                </button>
              ) : null
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function DateRangePicker({
  from, to, onChange, min, max, allowOpenEnded,
  placeholder = "Select dates", disabled, className,
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  min?: string
  max?: string
  /** Renders "→ Ongoing" for an empty `to` and offers "No end date". For
   *  open-ended validity windows like MiscCostDialog's Effective Till. */
  allowOpenEnded?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  /** Set by the first click; the second click closes the range. Separate from
   *  `from` so a half-finished selection never escapes to the caller. */
  const [pending, setPending] = useState("")
  const [hover, setHover] = useState("")
  const [view, setView] = useState(() => anchorMonth(from, min ?? ""))

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setView(anchorMonth(from, min ?? ""))
      setPending("")
      setHover("")
    }
  }

  function pick(iso: string) {
    if (!pending) {
      setPending(iso)
      setHover("")
      return
    }
    // Clicking before the start restarts the selection. Committing an inverted
    // range would silently filter to nothing / write a backwards window.
    if (isBefore(iso, pending)) {
      setPending(iso)
      return
    }
    onChange(pending, iso)
    setPending("")
    setHover("")
    setOpen(false)
  }

  const label = pending
    ? `${formatDisplay(pending)} → …`
    : from
      ? `${formatDisplay(from)} → ${formatDisplay(to) || (allowOpenEnded ? "Ongoing" : "…")}`
      : ""

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" disabled={disabled} className={cn(TRIGGER_CLASS, className)}>
          <span className={cn("truncate", !label && "text-muted-foreground")}>
            {label || placeholder}
          </span>
          <CalendarDays className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className={POPOVER_CLASS}>
          <CalendarBody
            months={2}
            view={view}
            onView={setView}
            from={pending || from}
            // While half-open, preview the range against the hovered day.
            to={pending ? hover : to}
            min={min}
            max={max}
            onPick={pick}
            onHover={setHover}
            footer={
              <div className="mt-2 flex items-center justify-between gap-2">
                {allowOpenEnded && pending ? (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      onChange(pending, "")
                      setPending("")
                      setOpen(false)
                    }}
                  >
                    No end date
                  </button>
                ) : <span />}
                {(from || pending) && (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      onChange("", "")
                      setPending("")
                      setOpen(false)
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit --incremental false
npm run lint:changed
```

Expected: clean. If `Popover.Portal` or `Popover.Content` is not found, the umbrella package's namespace shape differs — check how `components/ui/tooltip.tsx` consumes `Tooltip.*` and match it exactly rather than switching to a direct `@radix-ui/react-popover` import.

- [ ] **Step 3: Commit**

```bash
git add components/ui/date-picker.tsx
git commit -m "feat(ui): shared DatePicker and DateRangePicker"
```

---

### Task 3: Group A — the three range filters

**Files:**
- Modify: `app/po-tracking/po-procurement/PoProcurementClient.tsx:375-392`
- Modify: `app/po-tracking/invoices/InvoicesClient.tsx:82-91`
- Modify: `app/admin/activity/ActivityClient.tsx:102-115`

**Interfaces:**
- Consumes: `DateRangePicker` from `@/components/ui/date-picker` (Task 2).
- Produces: nothing downstream depends on these.

- [ ] **Step 1: `PoProcurementClient.tsx`** — replace lines 375–392 (the two `Date From` / `Date To` blocks) with one block. Add `import { DateRangePicker } from "@/components/ui/date-picker"` to the import list.

```tsx
              <div className="grid gap-1.5">
                <Label className="text-xs">Date Range</Label>
                <DateRangePicker
                  from={draftDateFrom}
                  to={draftDateTo}
                  onChange={(f, t) => {
                    setDraftDateFrom(f)
                    setDraftDateTo(t)
                  }}
                  className="h-9 text-sm"
                />
              </div>
```

The two draft state variables are unchanged, so `applyFilters` and the query string it builds need no edit.

- [ ] **Step 2: `InvoicesClient.tsx`** — replace lines 82–91 (the comment plus both `Input`s). Add the import.

```tsx
          {/* Invoice date, not the date it was entered: that's the number
              finance reconciles against. */}
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onChange={(f, t) => {
              setDateFrom(f)
              setDateTo(t)
            }}
            placeholder="Invoice date range"
            className="w-64 text-sm"
          />
```

Note the `w-64` — it replaces two `w-36` inputs, so the toolbar keeps roughly the same width. `clearFilters` already resets both state variables; leave it alone.

- [ ] **Step 3: `ActivityClient.tsx`** — replace lines 102–115 (both `Input`s). Add the import.

```tsx
        <DateRangePicker
          from={filters.from}
          to={filters.to}
          onChange={(f, t) => {
            setFilter("from", f)
            setFilter("to", t)
          }}
          placeholder="Date range"
          className="sm:w-64"
        />
```

Check `setFilter`'s implementation before committing: if it debounces or pushes a URL update per call, two calls in a row may drop the first. If so, use whatever batched setter the hook exposes (or call `setFilter` once with both keys) rather than two sequential calls.

- [ ] **Step 4: Verify in the browser**

```bash
npm run dev
```

Visit `/po-tracking/po-procurement`, `/po-tracking/invoices`, `/admin/activity`. For each: open the picker, confirm two months side by side, select a range, confirm the list filters and the trigger reads `01 Aug 2026 → 25 Aug 2026`. On `/admin/activity` confirm both dates land in the URL, not just one.

- [ ] **Step 5: Lint and type-check**

```bash
npx tsc --noEmit --incremental false
npm run lint:changed
```

- [ ] **Step 6: Commit**

```bash
git add app/po-tracking/po-procurement/PoProcurementClient.tsx app/po-tracking/invoices/InvoicesClient.tsx app/admin/activity/ActivityClient.tsx
git commit -m "feat(filters): dual-calendar range picker on PO, invoice and activity filters"
```

---

### Task 4: Group B — the three validity windows

**Files:**
- Modify: `app/masters/raw-materials/EditRmVendorRateDialog.tsx:184-194`
- Modify: `app/masters/packing-materials/EditPmVendorRateDialog.tsx:175-185`
- Modify: `app/manufacturing/[mfgId]/MiscCostDialog.tsx:185-200`

**Interfaces:**
- Consumes: `DateRangePicker` from `@/components/ui/date-picker` (Task 2).
- Produces: nothing. `form.effective_from` / `form.effective_to` / `form.effective_till` keep their names and types, so the submit payload, its Zod schema and the per-field approval diff are untouched.

- [ ] **Step 1: `EditRmVendorRateDialog.tsx`** — replace lines 184–194 (both `div.grid.gap-1` blocks, including the past-date warning). Add the import.

```tsx
            <div className="grid gap-1 col-span-2">
              <Label>Effective Period</Label>
              <DateRangePicker
                from={form.effective_from}
                to={form.effective_to}
                onChange={(f, t) => {
                  set("effective_from", f)
                  set("effective_to", t)
                }}
                min={today}
                allowOpenEnded
                disabled={!canEdit}
                placeholder="Select effective period"
              />
              {form.effective_from && form.effective_from < today && (
                <p className="text-xs text-destructive">Date cannot be in the past.</p>
              )}
            </div>
```

`min={today}` is preserved, and the past-date warning is kept: `min` blocks picking a past date in the calendar, but a record loaded with an already-past `effective_from` must still say so.

Confirm `set` accepts two sequential calls — if it is a `setForm(prev => ...)` updater this is safe; if it assigns from a stale closure, replace the two calls with one `setForm({ ...form, effective_from: f, effective_to: t })`.

Check whether the parent grid is `grid-cols-2`; if so `col-span-2` makes the single control span the row where two half-width fields used to sit. If the parent is a single column, drop `col-span-2`.

- [ ] **Step 2: `EditPmVendorRateDialog.tsx`** — same change at lines 175–185. The surrounding markup is identical to the RM dialog; use the same block, adjusting nothing but the file.

- [ ] **Step 3: `MiscCostDialog.tsx`** — replace lines 185–200 (the whole `grid grid-cols-2 gap-4` wrapper holding `mc-from` and `mc-till`). Add the import.

```tsx
          <div className="grid gap-1.5">
            <Label htmlFor="mc-period">
              Effective Period <span className="text-destructive">*</span>
            </Label>
            <DateRangePicker
              from={form.effective_from}
              to={form.effective_till}
              onChange={(f, t) => {
                set("effective_from", f)
                set("effective_till", t)
              }}
              allowOpenEnded
              placeholder="Select effective period"
            />
          </div>
```

Note the field is `effective_till` here, not `effective_to`. The required asterisk moves to the pair's label; `allowOpenEnded` is what keeps Till optional. `htmlFor="mc-period"` has no matching id now that the trigger is a button — either pass `id="mc-period"` (only `DatePicker` takes `id`, so for the range picker drop the `htmlFor` instead) or leave the `Label` without it. Prefer dropping `htmlFor`.

- [ ] **Step 4: Verify in the browser**

With `npm run dev` running:
- `/masters/raw-materials` → open a vendor rate edit → confirm the range control replaces both fields, that a past date is not selectable, and that "No end date" leaves Effective To empty.
- Same for `/masters/packing-materials`.
- `/manufacturing/<id>` → Misc. Cost tab → Add/Edit → confirm submitting with no end date still saves.
- On one of them, submit and confirm the approval in `/approvals` still shows `effective_from` and `effective_to` as separate diff rows.

- [ ] **Step 5: Lint and type-check**

```bash
npx tsc --noEmit --incremental false
npm run lint:changed
```

- [ ] **Step 6: Commit**

```bash
git add app/masters/raw-materials/EditRmVendorRateDialog.tsx app/masters/packing-materials/EditPmVendorRateDialog.tsx "app/manufacturing/[mfgId]/MiscCostDialog.tsx"
git commit -m "feat(masters): one range control for effective-period pairs"
```

---

### Task 5: Group C — the eleven single dates

**Files:**
- Modify: `components/masters/MaterialRateTable.tsx:471-476` and `:520-525`
- Modify: `app/masters/raw-materials/EditRmMfgRateDialog.tsx:164`
- Modify: `app/masters/packing-materials/EditPmMfgRateDialog.tsx:162`
- Modify: `app/po-tracking/po-procurement/ImpromptuPODialog.tsx:278-282`
- Modify: `app/po-tracking/po-procurement/AddPODialog.tsx:111-115`
- Modify: `app/po-tracking/po-inwarding/InvoiceFields.tsx:19-45` (the local `Field` wrapper)
- Modify: `app/masters/recipe-master/RecipeWizardSteps.tsx:226-231`
- Modify: `app/masters/recipe-master/RecipeEditDialog.tsx:135-141`
- Modify: `app/masters/raw-materials/AddRawMaterialWizard.tsx:609-614`
- Modify: `app/masters/packing-materials/AddPackingMaterialWizard.tsx:553-558`

**Interfaces:**
- Consumes: `DatePicker` from `@/components/ui/date-picker` (Task 2).
- Produces: nothing downstream.

Each of these adds `import { DatePicker } from "@/components/ui/date-picker"` to its import list.

- [ ] **Step 1: `MaterialRateTable.tsx`** — both filter panels. Replace lines 471–476:

```tsx
                    <DatePicker
                      value={draftEffectiveFrom}
                      onChange={setDraftEffectiveFrom}
                      className={inputCls}
                      placeholder="Any date"
                    />
```

and lines 520–525:

```tsx
                    <DatePicker
                      value={draftMfgEffectiveFrom}
                      onChange={setDraftMfgEffectiveFrom}
                      className={inputCls}
                      placeholder="Any date"
                    />
```

`inputCls` (defined at line 315) sets `h-9 w-full rounded-lg border ...` and ends with `dark:[color-scheme:dark]`, which was only ever for the native date widget's own chrome — harmless to leave, since `cn` keeps it and it now applies to nothing.

- [ ] **Step 2: `EditRmMfgRateDialog.tsx`** — replace line 164:

```tsx
              <DatePicker value={form.effective_from} onChange={(v) => set("effective_from", v)} disabled={!canEdit} />
```

- [ ] **Step 3: `EditPmMfgRateDialog.tsx`** — replace line 162 with the identical call (same field name, same `canEdit`).

```tsx
              <DatePicker value={form.effective_from} onChange={(v) => set("effective_from", v)} disabled={!canEdit} />
```

- [ ] **Step 4: `ImpromptuPODialog.tsx`** — replace lines 278–282, keeping `min={today}` and the sibling error line at 283:

```tsx
            <DatePicker
              id="ipo-dispatch"
              min={today}
              value={form.expected_on}
              onChange={(v) => set("expected_on", v)}
            />
```

- [ ] **Step 5: `AddPODialog.tsx`** — replace lines 111–115. This one is inside a `<td>` in a scrolling table, which is exactly why the popover portals:

```tsx
        <DatePicker
          min={today}
          value={row.expected_on}
          onChange={(v) => onChange("expected_on", v)}
          className="h-8 w-36 text-xs"
        />
```

- [ ] **Step 6: `InvoiceFields.tsx`** — the local `Field` wrapper at line 19 takes `type?: string` and forwards it to `Input`. Branch on `date` there so the Invoice Date call at line 108 needs no change. Replace the `<Input .../>` inside `Field` (lines 38–45) with:

```tsx
      {type === "date" ? (
        <DatePicker
          value={value}
          onChange={onChange}
          className={cn("h-9 text-sm", mono && "font-mono tabular-nums")}
        />
      ) : (
        <Input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn("h-9 text-sm", mono && "font-mono tabular-nums")}
        />
      )}
```

`Field`'s `onChange` is already `(v: string) => void`, so it passes straight through.

- [ ] **Step 7: `RecipeWizardSteps.tsx`** — replace lines 226–231, keeping the raw-input class string so it still matches the disabled input above it:

```tsx
          <DatePicker
            value={effectiveFrom}
            onChange={onChangeEffectiveFrom}
            placeholder="Optional"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
```

- [ ] **Step 8: `RecipeEditDialog.tsx`** — replace lines 135–141:

```tsx
              <DatePicker
                value={effectiveFrom}
                onChange={onChangeEffectiveFrom}
                disabled={saving}
                className="w-40 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
              />
```

- [ ] **Step 9: `AddRawMaterialWizard.tsx`** — replace lines 609–614, inside the per-row mfg entry grid:

```tsx
                        <DatePicker
                          value={entry.effective_from}
                          onChange={(v) => updateMfgEntry(i, "effective_from", v)}
                          className={inputCls}
                        />
```

- [ ] **Step 10: `AddPackingMaterialWizard.tsx`** — replace lines 553–558 with the identical call.

```tsx
                        <DatePicker
                          value={entry.effective_from}
                          onChange={(v) => updateMfgEntry(i, "effective_from", v)}
                          className={inputCls}
                        />
```

- [ ] **Step 11: Verify the clipping cases specifically**

With `npm run dev` running, check the three sites where the picker sits in an `overflow-auto` container — this is the failure mode a portal exists to prevent, and the one most likely to look fine on a tall page and break on a short one:

- `/po-tracking/po-procurement` → Add PO → add a row → open Expected On. The calendar must render fully, not be cut off by the table edge. Test with only **one** row, which is when the wrapper is shortest.
- `/masters/raw-materials` → Add Raw Material → the mfg-rates step → same check.
- `/masters/packing-materials` → same.

Then the plain ones: `/masters/recipe-master` (wizard step and the edit dialog), `/po-tracking/po-inwarding` → Add Invoice → Invoice Date, both material-master filter panels, both mfg-rate edit dialogs.

- [ ] **Step 12: Lint and type-check**

```bash
npx tsc --noEmit --incremental false
npm run lint:changed
```

- [ ] **Step 13: Commit**

```bash
git add components/masters/MaterialRateTable.tsx app/masters/raw-materials/EditRmMfgRateDialog.tsx app/masters/packing-materials/EditPmMfgRateDialog.tsx app/po-tracking/po-procurement/ImpromptuPODialog.tsx app/po-tracking/po-procurement/AddPODialog.tsx app/po-tracking/po-inwarding/InvoiceFields.tsx app/masters/recipe-master/RecipeWizardSteps.tsx app/masters/recipe-master/RecipeEditDialog.tsx app/masters/raw-materials/AddRawMaterialWizard.tsx app/masters/packing-materials/AddPackingMaterialWizard.tsx
git commit -m "feat(ui): shared DatePicker on the remaining single-date fields"
```

---

### Task 6: Final sweep

**Files:** none created; this task only verifies.

- [ ] **Step 1: Confirm no native date input survives**

```bash
grep -rn 'type="date"' app components lib
```

Expected: **no matches** in `app/`, `components/` or `lib/`, except the three explanatory comments — `lib/invoice/invoice-mapping.ts:178`, `app/po-tracking/po-inwarding/InvoiceLineItems.tsx:215`, `app/masters/recipe-master/recipe-format.ts:23`. Those mention `<input type="date">` in prose and must stay: `invoice-mapping.ts` still coerces extracted dates into that string shape, which is exactly what the new picker consumes.

- [ ] **Step 2: Full unit suite**

Run: `npm test`
Expected: PASS, including `date-ist.test.ts` and the new `date-calendar.test.ts`.

- [ ] **Step 3: Production build**

Stop `npm run dev` first — Next 16 holds one lock on `.next` and the build will refuse to start otherwise.

```bash
npm run build
```

Expected: succeeds. This is the check that matters; `tsc --noEmit` can pass on a file `next build` rejects.

- [ ] **Step 4: Commit anything outstanding**

```bash
git status
```

Expected: clean. If not, review and commit.

---

## Notes for the implementer

**Two-sequential-setState is the trap in Tasks 3 and 4.** Every group A and B site sets two state variables from one `onChange`. With a plain `useState` setter or a `setForm(prev => ...)` updater this is safe. It is *not* safe if the setter reads a stale closure (`setForm({ ...form, x })` twice in a row loses the first write) or if it pushes to the URL per call. Check each `set` / `setFilter` before assuming, and collapse to a single call where needed. `ActivityClient`'s `setFilter` and the rate dialogs' `set` are the two to look at hardest.

**`min` blocks selection; it does not validate existing data.** The vendor-rate dialogs keep their "Date cannot be in the past" warning for exactly this reason — a record loaded with a past `effective_from` must still say so even though the calendar won't let you pick one.

**What was deliberately left out** (spec, "Explicitly not doing"): presets like "Last 7 days", time-of-day, locale switching, month/year jump dropdowns, multi-range. Keyboard navigation clamps at the edge of the two rendered months rather than paging the view — marked with a `ponytail:` comment in `CalendarBody`.
