import * as React from "react"
import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tabs-list"
      role="tablist"
      className={cn("flex flex-wrap items-center gap-1 border-b border-border", className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  active = false,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="tabs-trigger"
      role="tab"
      aria-selected={active}
      className={cn(
        "relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium whitespace-nowrap transition-colors -mb-px border-b-2 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-sm",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger }
