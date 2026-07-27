import { Badge } from "@/components/ui/badge"

export function BomStatusBadge({ status }: { status: string | null }) {
  if (status === "in_review" || status === "in review") {
    return <Badge variant="warning" className="capitalize">In Review</Badge>
  }
  if (status === "draft") {
    return <Badge variant="secondary" className="capitalize">Draft</Badge>
  }
  if (status === "discontinued") {
    return <Badge variant="warning" className="capitalize">Discontinued</Badge>
  }
  return (
    <Badge variant={status === "active" ? "success" : "secondary"} className="capitalize">
      {status ?? "—"}
    </Badge>
  )
}
