import * as React from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"

export interface SegmentedToggleOption<T extends string> {
  key: T
  label: React.ReactNode
}

/** Pill-style 2+way toggle. Pass `getHref` for URL-driven navigation (the
 *  page re-renders server-side with only the selected view's data fetched —
 *  see ViewToggle usages) or `onSelect` for plain client-state toggles. */
export function SegmentedToggle<T extends string>({
  options,
  active,
  onSelect,
  getHref,
  size = "sm",
  className,
}: {
  options: readonly SegmentedToggleOption<T>[]
  active: T
  onSelect?: (key: T) => void
  getHref?: (key: T) => string
  size?: "sm" | "xs"
  className?: string
}) {
  const itemClass = (isActive: boolean) =>
    cn(
      "rounded-md font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      size === "xs" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
      isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
    )

  return (
    <div className={cn("inline-flex rounded-lg border border-input p-0.5", className)}>
      {options.map((opt) => {
        const isActive = active === opt.key
        if (getHref) {
          return (
            <Link key={opt.key} href={getHref(opt.key)} scroll={false} className={itemClass(isActive)}>
              {opt.label}
            </Link>
          )
        }
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect?.(opt.key)}
            className={itemClass(isActive)}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
