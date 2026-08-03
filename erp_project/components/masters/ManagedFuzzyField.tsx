"use client"

import { useState } from "react"
import { Label } from "@/components/ui/label"
import { FuzzySelect } from "@/components/ui/FuzzySelect"

/** Label + "pick from known options, or type a brand-new one" field — used by
 *  the RM Make / INCI Name inputs on both the Add and Edit material dialogs.
 *  Toggles between a FuzzySelect (existing options + "＋ Add new") and a plain
 *  text input (with a ✕ to cancel back to the dropdown) for entering a value
 *  that doesn't exist yet. */
export function ManagedFuzzyField({
  id,
  label,
  required = true,
  options,
  value,
  onChange,
  placeholder,
  newPlaceholder,
  disabled,
  isNew: isNewProp,
  onIsNewChange,
}: {
  id: string
  label: string
  required?: boolean
  options: string[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  newPlaceholder: string
  disabled?: boolean
  /** Pass both to control the new/existing toggle externally — e.g. when the
   *  parent needs to know "is this a freshly-typed value?" at submit time. */
  isNew?: boolean
  onIsNewChange?: (isNew: boolean) => void
}) {
  const [isNewState, setIsNewState] = useState(false)
  const isNew = isNewProp ?? isNewState
  const setIsNew = (v: boolean) => {
    onIsNewChange?.(v)
    if (isNewProp === undefined) setIsNewState(v)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {isNew ? (
        <div className="flex gap-1">
          <input
            autoFocus
            className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            placeholder={newPlaceholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() => { setIsNew(false); onChange("") }}
            className="h-9 px-2 rounded-lg border border-input bg-background text-muted-foreground hover:text-foreground text-sm"
          >✕</button>
        </div>
      ) : (
        <FuzzySelect
          options={options}
          value={value}
          onChange={onChange}
          onAddNew={() => { setIsNew(true); onChange("") }}
          placeholder={placeholder}
          disabled={disabled}
          className="h-9"
        />
      )}
    </div>
  )
}
