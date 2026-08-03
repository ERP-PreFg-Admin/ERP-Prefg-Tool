"use client"

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import Fuse from "fuse.js"
import { cn } from "@/lib/utils"

/** Matches the list's max-h below; needed as a number to decide flip direction. */
const LIST_MAX_H = 224
/** Below this, opening downward isn't worth it — flip above instead. */
const MIN_ROOM = 140

/**
 * Text input + fuzzy-filtered dropdown, for large option lists (Makes, INCI
 * Names, SKUs) where users only remember a few characters and exact
 * substring matching in a plain <select> makes finding the right entry slow.
 *
 * Drop-in replacement for a plain <select>: pass `onAddNew` to keep the
 * existing "+ Add new…" free-text fallback pattern used across the app.
 *
 * Defaults to plain string options. For object options (e.g. SKU rows),
 * pass `getLabel`/`getValue`/`searchKeys` — `value`/`onChange` still deal
 * only in the resolved string value, so callers don't need to change how
 * they store the selected value.
 */
export function FuzzySelect<T = string>({
  options,
  value,
  onChange,
  onAddNew,
  placeholder = "Select…",
  addNewLabel = "+ Add new…",
  className,
  disabled,
  getLabel = (opt: T) => String(opt),
  getValue = (opt: T) => String(opt),
  searchKeys,
}: {
  options: T[]
  value: string
  onChange: (value: string) => void
  onAddNew?: () => void
  placeholder?: string
  addNewLabel?: string
  className?: string
  disabled?: boolean
  getLabel?: (opt: T) => string
  getValue?: (opt: T) => string
  /** Fuse.js `keys` — required for object options, ignored for plain strings. */
  searchKeys?: string[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef     = useRef<HTMLInputElement>(null)
  const listRef      = useRef<HTMLDivElement>(null)
  /** Viewport box of the input, for the portalled list. Null until first open. */
  const [box, setBox] = useState<DOMRect | null>(null)

  const fuse = useMemo(
    () => new Fuse(options, searchKeys ? { threshold: 0.4, ignoreLocation: true, keys: searchKeys } : { threshold: 0.4, ignoreLocation: true }),
    [options, searchKeys]
  )

  const filtered = useMemo(() => {
    if (!query) return options
    return fuse.search(query).map((r) => r.item)
  }, [query, fuse, options])

  const selectedOption = useMemo(
    () => options.find((opt) => getValue(opt) === value),
    [options, value, getValue]
  )
  const displayValue = selectedOption ? getLabel(selectedOption) : value

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node
      // The list is portalled to <body>, so it isn't inside containerRef and has
      // to be excluded here or clicking an option would count as clicking away.
      if (listRef.current?.contains(t)) return
      if (containerRef.current && !containerRef.current.contains(t)) {
        setOpen(false)
        setQuery("")
      }
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [])

  // Track the input's viewport box while open. Capture phase because the
  // scrolling ancestor is usually a table wrapper, not the window.
  useEffect(() => {
    if (!open) return
    const measure = (e?: Event) => {
      // Scrolling the list itself doesn't move the input, and a fresh DOMRect is
      // always a new object — re-measuring here would re-render every wheel tick.
      if (e && listRef.current?.contains(e.target as Node)) return
      setBox(inputRef.current?.getBoundingClientRect() ?? null)
    }
    measure()
    window.addEventListener("scroll", measure, true)
    window.addEventListener("resize", measure)
    return () => {
      window.removeEventListener("scroll", measure, true)
      window.removeEventListener("resize", measure)
    }
  }, [open])

  function selectOption(opt: T) {
    onChange(getValue(opt))
    setQuery("")
    setOpen(false)
  }

  function selectAddNew() {
    onAddNew?.()
    setQuery("")
    setOpen(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const total = filtered.length + (onAddNew ? 1 : 0)
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, total - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (highlighted < filtered.length) selectOption(filtered[highlighted])
      else if (onAddNew) selectAddNew()
    } else if (e.key === "Escape") {
      setOpen(false)
      setQuery("")
    }
  }

  // Open downward unless the row is near the bottom of the viewport, which is
  // exactly the case that used to strand the list off-screen.
  const spaceBelow = box ? window.innerHeight - box.bottom - 8 : 0
  const spaceAbove = box ? box.top - 8 : 0
  const flipUp     = spaceBelow < MIN_ROOM && spaceAbove > spaceBelow
  const roomBelow  = Math.min(LIST_MAX_H, spaceBelow)
  const roomAbove  = Math.min(LIST_MAX_H, spaceAbove)

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed",
          className
        )}
        placeholder={placeholder}
        value={open ? query : displayValue}
        disabled={disabled}
        onFocus={() => {
          setOpen(true)
          setHighlighted(0)
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setHighlighted(0)
        }}
        onKeyDown={handleKeyDown}
      />
      {open && !disabled && box && createPortal(
        <div
          ref={listRef}
          // Fixed + portalled rather than absolute: most callers sit inside an
          // `overflow-auto` table, which clipped the list and left rows near the
          // bottom opening into a region you had to scroll the table to see.
          style={{
            left: box.left,
            width: box.width,
            ...(flipUp
              ? { bottom: window.innerHeight - box.top + 4, maxHeight: roomAbove }
              : { top: box.bottom + 4, maxHeight: roomBelow }),
          }}
          // pointer-events-auto is load-bearing: a modal Radix dialog sets
          // `pointer-events: none` on <body>, and this list is portalled there,
          // so without it the list renders but can't be scrolled or clicked.
          className="pointer-events-auto fixed z-9999 overflow-auto rounded-md border border-border bg-popover shadow-md"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>
          )}
          {filtered.map((opt, i) => (
            <div
              key={getValue(opt)}
              className={cn(
                "px-3 py-1.5 text-sm cursor-pointer",
                i === highlighted ? "bg-muted text-foreground" : "hover:bg-muted/60"
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                selectOption(opt)
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {getLabel(opt)}
            </div>
          ))}
          {onAddNew && (
            <div
              className={cn(
                "px-3 py-1.5 text-sm cursor-pointer border-t border-border text-primary",
                highlighted === filtered.length ? "bg-muted" : "hover:bg-muted/60"
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                selectAddNew()
              }}
              onMouseEnter={() => setHighlighted(filtered.length)}
            >
              {addNewLabel}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
