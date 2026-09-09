"use client"

/**
 * Shared "Reason for change" + "RM change"/"PM change"/"Kit contents" checkboxes, required
 * whenever a submission is actually editing an established Recipe (see
 * lib/validation/bom.ts's bomCreateFullSchema comment) — used by both
 * RecipeEditDialog (always an edit) and RecipeWizardSteps' Step4/Step5 (only when
 * the picked SKU already has an existing Recipe).
 */

export type ChangeTypeKey = "rm" | "pm" | "sku"

const OPTIONS: { key: ChangeTypeKey; label: string }[] = [
  { key: "rm", label: "RM change" },
  { key: "pm", label: "PM change" },
  { key: "sku", label: "Kit contents change" },
]

export function ChangeTypeCheckboxes({
  reason,
  onChangeReason,
  changeType,
  onChangeChangeType,
  disabled,
  hideRm,
  isKit,
}: {
  reason: string
  onChangeReason: (v: string) => void
  changeType: ChangeTypeKey[]
  onChangeChangeType: (v: ChangeTypeKey[]) => void
  disabled?: boolean
  /** RM is inherited from this variant family's base and can't change here, so
   *  offering "RM change" would be offering something the server rejects. */
  hideRm?: boolean
  /** A gift kit (lib/masters/kit-sku.ts). "Kit contents change" is offered only
   *  here, and only here does it mean anything — every other SKU is refused
   *  sku_lines outright, so the box would describe an impossible edit. */
  isKit?: boolean
}) {
  const options = OPTIONS.filter((o) => {
    if (o.key === "rm" && hideRm) return false
    if (o.key === "sku") return Boolean(isKit)
    return true
  })

  function toggle(key: ChangeTypeKey) {
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
