import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Bare icon-only row action (edit / compare / history, …) shared by every
 *  RM/PM rate table's action column. Disabled state (e.g. a row locked by a
 *  pending approval) swaps in a muted, non-interactive look. */
export function IconActionButton({
  icon: Icon,
  onClick,
  title,
  disabled,
  className,
}: {
  icon: LucideIcon
  onClick: () => void
  title: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded-md transition-colors",
        disabled
          ? "opacity-40 cursor-not-allowed text-muted-foreground"
          : "hover:bg-accent text-muted-foreground hover:text-foreground",
        className
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
