"use client"

/**
 * Shared "Reason for change" + "RM change"/"PM change" checkboxes, required
 * whenever a submission is actually editing an established Recipe (see
 * lib/validation/bom.ts's bomCreateFullSchema comment) — used by both
 * RecipeEditDialog (always an edit) and RecipeWizardSteps' Step4/Step5 (only when
 * the picked SKU already has an existing Recipe).
 */

const OPTIONS: { key: "rm" | "pm"; label: string }[] = [
  { key: "rm", label: "RM change" },
  { key: "pm", label: "PM change" },
]

export function ChangeTypeCheckboxes({
  reason,
  onChangeReason,
  changeType,
  onChangeChangeType,
  disabled,
  hideRm,
}: {
  reason: string
  onChangeReason: (v: string) => void
  changeType: ("rm" | "pm")[]
  onChangeChangeType: (v: ("rm" | "pm")[]) => void
  disabled?: boolean
  /** RM is inherited from this variant family's base and can't change here, so
   *  offering "RM change" would be offering something the server rejects. */
  hideRm?: boolean
}) {
  const options = hideRm ? OPTIONS.filter((o) => o.key !== "rm") : OPTIONS

  function toggle(key: "rm" | "pm") {
    onChangeChangeType(
      changeType.includes(key) ? changeType.filter((t) => t !== key) : [...changeType, key]
    )
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium mb-1">
          Reason for change <span className="text-destructive">*</span>
        </label>
        <textarea
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          rows={2}
          value={reason}
          onChange={(e) => onChangeReason(e.target.value)}
          disabled={disabled}
          placeholder="Why is this recipe being revised?"
        />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-xs font-medium">
          Type of change <span className="text-destructive">*</span>
        </span>
        {options.map((opt) => (
          <label key={opt.key} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={changeType.includes(opt.key)}
              onChange={() => toggle(opt.key)}
              disabled={disabled}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  )
}
