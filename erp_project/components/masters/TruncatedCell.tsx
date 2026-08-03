"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * Renders a value truncated with an ellipsis inside a table cell; clicking
 * it opens a dialog with the full, untruncated text. Use for free-text
 * columns (names, INCI names, etc.) that can overflow a fixed-width table.
 */
export function TruncatedCell({
  value,
  label,
  className,
}: {
  value: unknown
  label: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const text = value == null || value === "" ? "—" : String(value)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={text}
        className={cn("block max-w-full truncate text-left hover:underline decoration-dotted underline-offset-2", className)}
      >
        {text}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{text}</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
