"use client"

import { AlertTriangle, MoreVertical } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

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
  warning:     "text-amber-700 hover:bg-amber-50",
  destructive: "text-destructive hover:bg-destructive/10",
}

export default function PoActionMenu({ actions }: { actions: MenuAction[] }) {
  const [open, setOpen]     = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const ref                 = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
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

      {open && (
        <div
          className={cn(
            "absolute right-0 z-50 min-w-45 rounded-md border border-border bg-popover shadow-md",
            openUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
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
        </div>
      )}
    </div>
  )
}
