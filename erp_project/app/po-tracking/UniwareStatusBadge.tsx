// What Unicommerce last said about a mirrored PO. Display only — the refresh is
// one Sync button per page (SyncUniwareButton), not one per row.
//
// Shared by the invoices tab and the PO Inwarding table so the two render the
// status identically; the PO table has no timestamp to pass, since its query
// selects the status alone.

import { Badge } from "@/components/ui/badge"
import { IST } from "@/lib/date"

const stamp = (v: string | null) =>
  v ? new Date(v).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: IST }) : null

export default function UniwareStatusBadge({
  status,
  syncedAt = null,
}: {
  status: string | null
  /** Absent on the PO table. Null means never synced, which the title says. */
  syncedAt?: string | null
}) {
  if (!status) return <span className="text-muted-foreground">—</span>

  const when = stamp(syncedAt)
  return (
    // Uniware's own status names, so no colour mapping — a variant per name would
    // imply a meaning we haven't confirmed.
    <Badge variant="secondary" title={when ? `As of ${when}` : undefined}>
      {status}
    </Badge>
  )
}
