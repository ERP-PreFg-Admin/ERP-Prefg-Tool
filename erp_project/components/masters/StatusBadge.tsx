import { Badge } from "@/components/ui/badge"

/** Renders the approval-flow status (draft/in_review/rejected/active/…) the same way everywhere. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (status === "in_review" || status === "in review") return <Badge variant="info" className="capitalize">In Review</Badge>
  if (status === "rejected")     return <Badge variant="destructive" className="capitalize">Rejected</Badge>
  if (status === "draft")        return <Badge variant="secondary" className="capitalize">Draft</Badge>
  if (status === "discontinued") return <Badge variant="warning" className="capitalize">Discontinued</Badge>
  return (
    <Badge variant={status === "active" ? "success" : "secondary"} className="capitalize">
      {status ?? "—"}
    </Badge>
  )
}
