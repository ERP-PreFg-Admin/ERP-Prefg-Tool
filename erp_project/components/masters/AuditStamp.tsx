import { formatDateTimeIST } from "@/lib/date"

// The one "who · when" stamp every master history view uses.
export function AuditStamp({
  label, name, at,
}: {
  label?: string
  name: string | null | undefined
  at: string | Date | null | undefined
}) {
  if (!name && !at) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="space-y-0.5 text-xs">
      {label && <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>}
      <div className="font-medium text-foreground">{name ?? "Unknown"}</div>
      <div className="text-[11px] text-muted-foreground tabular-nums">{formatDateTimeIST(at)}</div>
    </div>
  )
}
