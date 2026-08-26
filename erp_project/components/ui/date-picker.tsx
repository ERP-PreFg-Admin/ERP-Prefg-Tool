"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type WheelEvent } from "react"
import { Popover } from "radix-ui"
import { ChevronLeft, ChevronRight, ChevronDown, CalendarDays } from "lucide-react"
import { cn } from "@/lib/utils"
import { ScrollFade } from "@/components/ui/scroll-fade"
import {
  WEEKDAYS, MONTH_NAMES, monthMatrix, addMonths, anchorMonth, monthLabel,
  calendarYears, isMonthDisabled, formatDisplay, isBefore, isInRange, isDisabledDate,
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

const FOOTER_BTN_CLASS =
  "rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"

/** The month/year label, which opens the picker panel below. */
const HEADER_BTN_CLASS =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

/** One month or year cell. Same shape and states as a day cell in MonthGrid, so
 *  the panel reads as part of the calendar rather than a dropdown over it. */
const PICK_CELL_CLASS =
  "rounded-md text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30"

/** Width of one month grid — the panel matches it so opening the picker doesn't
 *  resize the popover under the cursor. */
const GRID_W = { 1: "w-[15.75rem]", 2: "w-[33.5rem]" } as const

/**
 * The nearest scrolling ancestor of `from`, stopping at `bound`.
 *
 * ScrollFade owns the scroll container, so it is found from a child rather than
 * held in a ref, and bounded so the walk cannot escape into the page's own
 * scroller.
 */
function scrollParent(from: HTMLElement | null, bound: HTMLElement | null): HTMLElement | null {
  let el = from
  while (el && el !== bound && el.scrollHeight <= el.clientHeight) el = el.parentElement
  return el && el !== bound ? el : null
}

/**
 * Month and year chooser, shown in place of the day grid.
 *
 * Months are a 3x4 block and years a scrolling column, both visible at once, so
 * "March 2023" is two clicks with no paging. It replaced two native <select>s:
 * an <option> list is drawn by the OS, which ignores padding, radius and hover
 * and opens white inside a dark app.
 *
 * Year first, then month: picking a year keeps the panel open (you still owe a
 * month), picking a month closes it. That is the order the label reads in and it
 * means the common case — right year, wrong month — is a single click.
 */
function MonthYearPanel({
  view, onView, onClose, months, min, max,
}: {
  view: { y: number; m: number }
  onView: (next: { y: number; m: number }) => void
  onClose: () => void
  months: 1 | 2
  min?: string
  max?: string
}) {
  const years = calendarYears(view.y, min, max)
  const panelRef = useRef<HTMLDivElement>(null)

  // Centre the current year on open. scrollTop is set directly rather than by
  // scrollIntoView, which walks up every ancestor and would scroll the page
  // behind the popover too.
  //
  // The scroll container belongs to ScrollFade, so it is found from the selected
  // cell instead of held in a ref — bounded by the panel so the walk can't
  // escape into the page's own scroller.
  useEffect(() => {
    const panel = panelRef.current
    const current = panel?.querySelector<HTMLButtonElement>("[data-current='true']")
    const list = scrollParent(current?.parentElement ?? null, panel)
    if (current && list) {
      list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.clientHeight / 2
    }
  }, [])

  /**
   * Scroll the year list by hand.
   *
   * The picker is portalled to `document.body`, so inside a Radix Dialog it sits
   * OUTSIDE the subtree that dialog's scroll lock allows — react-remove-scroll
   * then eats the wheel event and the list looks frozen even though the fade
   * says there is more below. Every date field in a dialog hits this.
   *
   * Doing the scroll here, and stopping the event before the document-level
   * blocker sees it, behaves identically in or out of a dialog: exactly one
   * scroll per wheel event.
   */
  function onWheel(e: WheelEvent<HTMLDivElement>) {
    const list = scrollParent(e.currentTarget, panelRef.current)
    if (!list) return
    e.preventDefault()
    e.stopPropagation()
    list.scrollTop += e.deltaY
  }

  return (
    <div ref={panelRef} className={cn("flex gap-3", GRID_W[months])}>
      <div className="grid flex-1 grid-cols-3 gap-1 content-start">
        {MONTH_NAMES.map((name, i) => {
          const m = i + 1
          const selected = m === view.m
          return (
            <button
              key={name}
              type="button"
              disabled={isMonthDisabled(view.y, m, min, max)}
              aria-pressed={selected}
              onClick={() => { onView({ y: view.y, m }); onClose() }}
              className={cn(
                PICK_CELL_CLASS, "h-9",
                selected ? "bg-primary font-medium text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {name}
            </button>
          )
        })}
      </div>

      <div className="w-px bg-border" />

      {/* ScrollFade, not a plain overflow container: it hides the scrollbar and
          draws an edge fade + chevron in its place, so "there is more below"
          survives losing the bar. Fixed height so the panel is the same size
          whichever year is centred, and the popover doesn't grow with the range. */}
      <ScrollFade axis="y" className="h-[13.5rem] w-16 shrink-0">
        <div className="grid gap-1 pr-0.5" onWheel={onWheel}>
          {years.map((y) => {
            const selected = y === view.y
            return (
              <button
                key={y}
                type="button"
                data-current={selected}
                aria-pressed={selected}
                onClick={() => onView({ y, m: view.m })}
                className={cn(
                  PICK_CELL_CLASS, "h-8 w-full",
                  selected ? "bg-primary font-medium text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {y}
              </button>
            )
          })}
        </div>
      </ScrollFade>
    </div>
  )
}

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
  const [picking, setPicking] = useState(false)

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
        <div className="flex flex-1 items-center justify-around">
          {/* The label opens the picker — reaching a date three years back was
              36 chevron clicks. */}
          <button
            type="button"
            className={HEADER_BTN_CLASS}
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
          >
            {monthLabel(view.y, view.m)}
            <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", picking && "rotate-180")} />
          </button>
          {/* The right month stays derived from the left, so the two are always
              adjacent — a second picker is exactly the "August next to next
              March" the single chevron pair exists to prevent. Hidden while
              picking, since the panel replaces both grids. */}
          {months === 2 && !picking && (
            <span className="text-sm font-medium">{monthLabel(right.y, right.m)}</span>
          )}
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
      {picking ? (
        <MonthYearPanel
          view={view}
          onView={onView}
          onClose={() => setPicking(false)}
          months={months}
          min={grid.min}
          max={grid.max}
        />
      ) : (
        <div className="flex gap-4">
          <MonthGrid y={view.y} m={view.m} {...grid} />
          {months === 2 && <MonthGrid y={right.y} m={right.m} {...grid} />}
        </div>
      )}
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
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    className={FOOTER_BTN_CLASS}
                    onClick={() => {
                      onChange("")
                      setOpen(false)
                    }}
                  >
                    Clear
                  </button>
                </div>
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
                    className={FOOTER_BTN_CLASS}
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
                    className={FOOTER_BTN_CLASS}
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
