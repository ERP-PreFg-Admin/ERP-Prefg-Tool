"use client"

import { AlertTriangle, MoreVertical } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

export type MenuAction = {
  label: string
  icon: React.ReactNode
  onClick: () => void
  variant?: "default" | "warning" | "destructive"
  disabled?: boolean
  disabledReason?: string
}

const VARIANT_CLS: Record<string, string> = {
  default:     "text-foreground hover:bg-accent",
  warning:     "text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40",
  destructive: "text-destructive hover:bg-destructive/10",
}

export default function PoActionMenu({ actions }: { actions: MenuAction[] }) {
  const [open, setOpen]     = useState(false)
  const [openUp, setOpenUp] = useState(false)
  /** The button's viewport box — the portalled menu is positioned off it. */
  const [box, setBox]       = useState<DOMRect | null>(null)
  const ref                 = useRef<HTMLDivElement>(null)
  const menuRef             = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      const target = e.target as Node
      // Both refs: the menu is portalled to <body>, so it is not inside `ref`
      // and a click on an item would otherwise read as a click outside.
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  // Keep the menu on the button while it's open. Capture phase, because what
  // scrolls is the table wrapper, not the window.
  useEffect(() => {
    if (!open) return
    const measure = () => setBox(ref.current?.getBoundingClientRect() ?? null)
    measure()
    window.addEventListener("scroll", measure, true)
    window.addEventListener("resize", measure)
    return () => {
      window.removeEventListener("scroll", measure, true)
      window.removeEventListener("resize", measure)
    }
  }, [open])

  if (actions.length === 0) return null

  function toggle() {
    if (!open && ref.current) {
      // Flip upward when there isn't enough room below (e.g. the last rows
      // of a table) so the menu doesn't get cut off / hidden behind the
      // pagination bar.
      const rect = ref.current.getBoundingClientRect()
      const estimatedMenuHeight = actions.length * 36 + 16
      setOpenUp(window.innerHeight - rect.bottom < estimatedMenuHeight)
    }
    setOpen((v) => !v)
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={toggle}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-input hover:bg-accent transition-colors"
        aria-label="More actions"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {open && box && createPortal(
        <div
          ref={menuRef}
          // Fixed + portalled rather than absolute, for the reason FuzzySelect's
          // list is: the table sits in an `overflow-auto` wrapper, which clipped
          // the menu. On a full page the box is tall enough to hide that; with a
          // single row the menu opened *into* the table and had to be scrolled to.
          style={{
            right: window.innerWidth - box.right,
            ...(openUp ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }),
          }}
          // pointer-events-auto is load-bearing: a modal dialog sets
          // `pointer-events: none` on <body>, and this menu is portalled there.
          className="pointer-events-auto fixed z-9999 min-w-45 rounded-md border border-border bg-popover shadow-md"
        >
          {actions.map((action, i) => (
            action.disabled ? (
              <div
                key={i}
                title={action.disabledReason}
                className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground cursor-not-allowed opacity-60"
              >
                {action.icon}
                {action.label}
                <AlertTriangle className="ml-auto h-3 w-3 text-amber-400" />
              </div>
            ) : (
              <button
                key={i}
                onClick={() => { setOpen(false); action.onClick() }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors ${VARIANT_CLS[action.variant ?? "default"]}`}
              >
                {action.icon}
                {action.label}
              </button>
            )
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
