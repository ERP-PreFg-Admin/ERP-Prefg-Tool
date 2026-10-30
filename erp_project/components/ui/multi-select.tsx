"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/** A Select-styled dropdown of checkboxes. Nothing ticked reads as `placeholder` (usually "All …"). */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  className,
}: {
  options: readonly (readonly [string, string])[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const labels = options.filter(([v]) => value.includes(v)).map(([, l]) => l)
  const summary = labels.length === 0 ? placeholder : labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center rounded-lg border border-input bg-background pl-3 pr-8 text-left text-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          labels.length === 0 ? "text-muted-foreground" : "text-foreground"
        )}
      >
        <span className="truncate">{summary}</span>
      </button>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      {open && (
        <div role="listbox" aria-multiselectable className="absolute left-0 right-0 z-50 mt-1 rounded-lg border bg-popover p-1 shadow-md">
          {options.map(([v, l]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <input type="checkbox" className="h-3.5 w-3.5" checked={value.includes(v)} onChange={() => toggle(v)} />
              {l}
            </label>
          ))}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  )
}
