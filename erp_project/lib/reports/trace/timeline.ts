// PO timeline (views-plan B7): one PO's dated events in order, with the days between steps and the gaps the
// data can't fill. Pure; times are UTC instants in, IST stamps out.

export type TimelineInput = {
  po: { po_no: string; po_date: string | null; email_sent_at: string | null; status: string | null; reference_po: string | null; po_type: string | null }
  approvals: { module: string; status: string; raised_on: string | null; approved_on: string | null; raised_by: string | null; approved_by: string | null }[]
  history: { action_type: string; field_name: string | null; old_value: string | null; new_value: string | null; changed_on: string | null; changed_by: string | null }[]
  invoices: { invoice_no: string; created_at: string | null; reverted_at: string | null; against_po_no: string; qty: number }[]
  grns: { grn_code: string; invoice_no: string; grn_created_at: string | null; total_qty: number; total_rejected_qty: number }[]
}

export type TimelineKind = "raise" | "approval" | "mail" | "edit" | "split" | "receipt" | "invoice" | "grn" | "revert" | "close" | "other"
export type TimelineEvent = { at: string; kind: TimelineKind; label: string; detail: string | null; by: string | null; days_since_prev: number | null }

const ist = (v: string | null) => {
  if (!v) return null
  const t = Date.parse(v.includes("T") || v.endsWith("Z") ? v : `${v.replace(" ", "T")}Z`)
  if (!Number.isFinite(t)) return null
  const s = new Date(t + 5.5 * 3_600_000).toISOString()
  return { ms: t, stamp: `${s.slice(0, 10)} ${s.slice(11, 16)}` }
}
const n = (v: string | null) => Number(v ?? 0)

function historyEvent(h: TimelineInput["history"][number]): Omit<TimelineEvent, "at" | "days_since_prev" | "by"> {
  const f = h.field_name ?? ""
  if (h.action_type === "create") return { kind: "raise", label: "PO created in history", detail: null }
  if (f === "received_qty") {
    const d = n(h.new_value) - n(h.old_value)
    return { kind: d >= 0 ? "receipt" : "revert", label: d >= 0 ? `Received ${d}` : `Receipt reversed ${-d}`, detail: `${h.old_value ?? 0} → ${h.new_value}` }
  }
  if (f === "split") return { kind: "split", label: "Split", detail: h.new_value }
  if (f === "revert_reason") return { kind: "revert", label: "Invoice reverted", detail: h.new_value }
  if (f === "edit_reason") return { kind: "edit", label: "Draft edit reason", detail: h.new_value }
  if (f === "status") {
    const to = h.new_value ?? ""
    const close = ["cancelled", "short_closed", "discarded", "received", "reverted"].includes(to)
    return { kind: close ? "close" : "edit", label: `Status ${h.old_value || "—"} → ${to}`, detail: null }
  }
  return { kind: "edit", label: `${f.replace(/_/g, " ")} changed`, detail: `${h.old_value ?? "—"} → ${h.new_value ?? "—"}` }
}

export function buildTimeline(x: TimelineInput) {
  const raw: (Omit<TimelineEvent, "days_since_prev"> & { ms: number })[] = []
  const push = (when: string | null, e: Omit<TimelineEvent, "at" | "days_since_prev">) => {
    const t = ist(when)
    if (t) raw.push({ ...e, at: t.stamp, ms: t.ms })
  }

  for (const a of x.approvals) {
    const what = a.module === "PO_EDIT" ? "Draft edit" : "PO"
    push(a.raised_on, { kind: "raise", label: `${what} submitted for approval`, detail: null, by: a.raised_by })
    if (a.approved_on) push(a.approved_on, { kind: "approval", label: `${what} ${a.status}`, detail: null, by: a.approved_by })
  }
  push(x.po.email_sent_at, { kind: "mail", label: "Mailed to the manufacturer", detail: null, by: null })
  for (const h of x.history) push(h.changed_on, { ...historyEvent(h), by: h.changed_by })
  for (const i of x.invoices) {
    const via = i.against_po_no === x.po.po_no ? "" : ` (against split ${i.against_po_no})`
    push(i.created_at, { kind: "invoice", label: `Invoice ${i.invoice_no} inwarded`, detail: `${i.qty} units${via}`, by: null })
    if (i.reverted_at) push(i.reverted_at, { kind: "revert", label: `Invoice ${i.invoice_no} reverted`, detail: null, by: null })
  }
  for (const g of x.grns) {
    const rej = g.total_rejected_qty ? `, ${g.total_rejected_qty} rejected` : ""
    push(g.grn_created_at, { kind: "grn", label: `GRN ${g.grn_code}`, detail: `${g.total_qty} arrived${rej} · invoice ${g.invoice_no}`, by: null })
  }

  raw.sort((a, b) => a.ms - b.ms)
  const events: TimelineEvent[] = raw.map(({ ms, ...e }, i) => ({
    ...e, days_since_prev: i === 0 ? null : Math.round((ms - raw[i - 1].ms) / 86_400_000),
  }))

  const gaps: string[] = []
  if (!x.history.some((h) => h.action_type === "create") && x.approvals.length === 0)
    gaps.push("No creation record: the PO predates history (or was imported), so its raise date is the PO date only.")
  if (!x.po.email_sent_at && !["draft", "discarded"].includes(x.po.status ?? "") && x.po.po_type !== "inward")
    gaps.push("Never mailed to the manufacturer.")
  if (x.invoices.length > 0 && x.grns.length === 0) gaps.push("Invoiced, but no GRN on file (or GRNs not synced yet).")
  return { events, gaps, po_date: x.po.po_date }
}
