import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export type FormFieldConfig = {
  key: string
  label: string
  required?: boolean
  colSpan?: 1 | 2
  placeholder?: string
  type?: string
  isSelect?: boolean
  options?: readonly { value: string; label: string }[]
  /** Skip the leading blank "Select…" option — for selects that always carry a valid default. */
  noBlankOption?: boolean
}

/** One "Label + Input | select" row, driven by a field config — the add/edit
 *  master dialogs render a whole form as `fields.map((f) => <FormField .../>)`
 *  instead of hand-rolling this block once per field. Keep using a plain
 *  `<select>` here, not a styled wrapper component — it's what every one of
 *  these dialogs already relies on. */
export function FormField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormFieldConfig
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", field.colSpan === 2 && "col-span-2")}>
      <Label htmlFor={field.key}>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {field.isSelect ? (
        <select
          id={field.key}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {!field.noBlankOption && <option value="">{field.placeholder ?? "Select…"}</option>}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <Input
          id={field.key}
          type={field.type ?? "text"}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </div>
  )
}
