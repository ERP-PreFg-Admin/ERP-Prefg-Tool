"use client"

/**
 * One toggle-button + Apply/Clear filter panel, shared by every master table
 * instead of each page choosing its own interaction (a toggle panel here, an
 * always-visible row of selects there, no filters at all somewhere else).
 * Draft state still lives in the calling page (each filter's shape differs
 * too much to generalize) — this only owns the show/hide chrome and layout.
 */

import { useState } from "react"
import { Filter, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ToggleButton } from "@/components/ui/toggle-button"

export function useFilterPanel() {
  const [open, setOpen] = useState(false)
  return { open, toggle: () => setOpen((v) => !v), close: () => setOpen(false) }
}

export function FilterToggleButton({ open, onToggle, activeCount }: {
  open: boolean
  onToggle: () => void
  activeCount: number
}) {
  return (
    <ToggleButton size="lg" pressed={open || activeCount > 0} onClick={onToggle}>
      <Filter className="h-3.5 w-3.5" />
      Filters
      {activeCount > 0 && (
        <span className="ml-0.5 rounded-full bg-blue-600 px-1.5 py-0 text-[10px] text-white">
          {activeCount}
        </span>
      )}
    </ToggleButton>
  )
}

export function FilterPanel({ open, onClose, onApply, onClear, children }: {
  open: boolean
  onClose: () => void
  onApply: () => void
  onClear: () => void
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <Card className="border-blue-200 mb-5">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">Filters</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {children}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={onClear}>Clear</Button>
          <Button size="sm" onClick={onApply}>Apply</Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** One labeled field inside a FilterPanel's grid. */
export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}
