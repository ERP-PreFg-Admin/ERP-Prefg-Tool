import { Badge } from "@/components/ui/badge"

/** RM and PM get their own fixed hue so a scan down the column reads as
 *  color, not text — sky for RM (raw materials), violet for PM (packing). */
const CHANGE_TYPE_STYLE: Record<string, string> = {
  rm: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  pm: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
}
const CHANGE_TYPE_LABEL: Record<string, string> = { rm: "RM", pm: "PM" }

/** Renders a BOM's comma-joined "rm"/"pm" change_type value (see
 *  approvals.approval_items' "__change_type__" sentinel item) as small
 *  colored tags instead of plain text — used by BomTable/BomHistoryTable. */
export function ChangeTypeBadges({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground/50">—</span>
  return (
    <div className="flex gap-1">
      {value.split(",").map((tag) => (
        <Badge key={tag} className={CHANGE_TYPE_STYLE[tag] ?? ""}>
          {CHANGE_TYPE_LABEL[tag] ?? tag}
        </Badge>
      ))}
    </div>
  )
}
