import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Styled wrapper around the native <select> — same element, same keyboard/
 * accessibility/mobile-picker behavior, just one consistent look instead of
 * every call site hand-rolling its own height/padding/focus-ring classes.
 * Not a custom dropdown widget: for large or fuzzy-searchable option lists,
 * use FuzzySelect instead.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "h-9 appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
)
Select.displayName = "Select"
