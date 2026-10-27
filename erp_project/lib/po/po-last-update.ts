// The newest thing that happened to a PO, for FG PO Tracking's "Last updated" column.
// Pure: picks across history_pos, the PO approval and the mail stamp, which the list query reads.

type When = string | Date | null | undefined

export type LastUpdateInput = {
  hist_at?: When
  /** `action_type|field_name|new_value` of the newest history_pos row. */
  hist_kind?: string | null
  approved_at?: When
  email_sent_at?: When
}

export type LastUpdate = { at: Date; label: string }

const STATUS_LABEL: Record<string, string> = {
  cancelled: "Cancelled",
  short_closed: "Short closed",
  received: "Received",
  reverted: "Reverted",
}

const EDIT_FIELDS = new Set(["qty", "expected_on", "destination", "remarks", "mfg_unit", "edit_reason"])

export function historyLabel(kind: string | null | undefined): string {
  const [action, field = "", value = ""] = (kind ?? "").split("|")
  if (action === "create") return "Created"
  if (field === "received_qty") return "Received"
  if (field === "split") return "Split"
  if (field === "revert_reason") return "Invoice reverted"
  if (field === "status") return STATUS_LABEL[value] ?? "Status changed"
  if (EDIT_FIELDS.has(field)) return "Edited"
  return "Updated"
}

function toDate(v: When): Date | null {
  if (v == null || v === "") return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Null when nothing is recorded. On a tie the later step in the PO's life wins (mail > approval > history). */
export function lastPoUpdate(r: LastUpdateInput): LastUpdate | null {
  const candidates: [Date | null, string][] = [
    [toDate(r.hist_at), historyLabel(r.hist_kind)],
    [toDate(r.approved_at), "Approved"],
    [toDate(r.email_sent_at), "Mail sent"],
  ]
  let best: LastUpdate | null = null
  for (const [at, label] of candidates) {
    if (at && (!best || at.getTime() >= best.at.getTime())) best = { at, label }
  }
  return best
}
