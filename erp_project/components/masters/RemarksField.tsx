"use client"

/**
 * Label + helper text + preset "quick pick" chips + Textarea, for the
 * mandatory reason/remarks field every approval-gated edit collects.
 * Clicking a preset fills the textarea with that text — a starting point the
 * user can still edit, not a rigid choice — so a blank textarea doesn't leave
 * people guessing what's expected of them.
 */

import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

export const EDIT_REMARK_PRESETS = [
  "Correcting a data entry error",
  "Updated per request",
  "Periodic data refresh",
  "Compliance/documentation update",
]

export const RATE_REMARK_PRESETS = [
  "Annual rate revision",
  "Price change from vendor/manufacturer",
  "Correcting a data entry error",
  "Renegotiated rate",
]

export const PO_REASON_PRESETS = [
  "Urgent replenishment",
  "Stock-out risk",
  "New SKU launch",
  "Correcting a previous PO",
]

export const REJECTION_REASON_PRESETS = [
  "Incorrect or incomplete data",
  "Missing required documentation",
  "Needs manager review first",
  "Duplicate submission",
]

export function RemarksField({
  id,
  label = "Remarks",
  required = true,
  helperText = "Required for every edit — briefly explain the reason for this change.",
  value,
  onChange,
  disabled,
  placeholder = "Reason for this change…",
  presets,
}: {
  id: string
  label?: string
  required?: boolean
  helperText?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  presets: string[]
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            disabled={disabled}
            className="rounded-full border border-input bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {preset}
          </button>
        ))}
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
    </div>
  )
}
