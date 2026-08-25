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

const FOOTER_BTN_CLASS =
  "rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"

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
