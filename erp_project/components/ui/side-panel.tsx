"use client"

/**
 * A right-edge slide-over for read-only detail — the "click a row to see
 * everything" pattern, where a modal dialog would be wrong because the user is
 * inspecting rather than editing.
 *
 * Built on the same Radix Dialog primitive as components/ui/dialog.tsx rather
 * than hand-rolled, so the focus trap, Escape handling, scroll lock and
 * aria-modal wiring come for free. The only real differences are the position
 * and the slide direction.
 */

import * as React from "react"
import { Dialog } from "radix-ui"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

const SidePanel = Dialog.Root
const SidePanelTrigger = Dialog.Trigger
const SidePanelClose = Dialog.Close

const SidePanelContent = React.forwardRef<
  React.ElementRef<typeof Dialog.Content>,
  React.ComponentPropsWithoutRef<typeof Dialog.Content>
>(({ className, children, ...props }, ref) => (
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
    <Dialog.Content
      ref={ref}
      className={cn(
        // Full height at the right edge. overflow-y-auto here, not on an inner
        // wrapper, so a long body scrolls without the header leaving the panel.
        "fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l bg-background p-6 shadow-lg",
        "duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        className
      )}
      {...props}
    >
      {children}
      <Dialog.Close className="absolute right-4 top-4 rounded-md p-1 opacity-60 transition-opacity hover:bg-accent hover:opacity-100">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
))
SidePanelContent.displayName = "SidePanelContent"

const SidePanelHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-5 pr-8", className)} {...props} />
)

const SidePanelTitle = React.forwardRef<
  React.ElementRef<typeof Dialog.Title>,
  React.ComponentPropsWithoutRef<typeof Dialog.Title>
>(({ className, ...props }, ref) => (
  <Dialog.Title
    ref={ref}
    className={cn("font-heading text-lg font-semibold leading-tight tracking-tight", className)}
    {...props}
  />
))
SidePanelTitle.displayName = "SidePanelTitle"

const SidePanelDescription = React.forwardRef<
  React.ElementRef<typeof Dialog.Description>,
  React.ComponentPropsWithoutRef<typeof Dialog.Description>
>(({ className, ...props }, ref) => (
  <Dialog.Description ref={ref} className={cn("mt-1 text-sm text-muted-foreground", className)} {...props} />
))
SidePanelDescription.displayName = "SidePanelDescription"

/** A labelled read-only value. Renders an em dash for anything empty, so a blank
 *  field looks deliberately blank rather than like a rendering bug. */
export function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  const empty = value === null || value === undefined || value === ""
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-sm", mono && "font-mono text-xs", empty && "text-muted-foreground")}>
        {empty ? "—" : value}
      </span>
    </div>
  )
}

export {
  SidePanel,
  SidePanelTrigger,
  SidePanelContent,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelDescription,
  SidePanelClose,
}
