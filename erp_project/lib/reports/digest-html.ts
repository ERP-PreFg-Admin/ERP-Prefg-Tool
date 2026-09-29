/**
 * The daily digest's body. Pure, so a unit test can import it.
 * Inline styles and tables only — Outlook ignores <style> and most of flexbox.
 */

export const  escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

/** A section either loaded or it didn't. The mail says which, in place. */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string }

export type DigestData = {
  day: string
  pos: Section<{ status: string; cnt: number }[]>
  posMailed: Section<number>
  emails: Section<{
    flows: { flow: string; sent: number; failed: number; recipients: number }[]
    providers: string[]
    truncated: boolean
  }>
  approvalsRaised: Section<{ module: string; cnt: number }[]>
  approvalsDecided: Section<{ module: string; status: string; cnt: number }[]>
  approvalsPending: Section<{ module: string; pending: number; oldest_hours: number }[]>
  invoices: Section<{ uniware_status: string; cnt: number }[]>
}

export const num = (v: number) => v.toLocaleString("en-IN")

export const TITLE = "margin:24px 0 6px;font-size:15px;color:#111;border-bottom:2px solid #eee;padding-bottom:4px"
const TD = "padding:5px 10px;border-bottom:1px solid #eee"
const TH = "padding:5px 10px;border-bottom:2px solid #ddd;text-align:left;font-weight:600;color:#555"
export const MUTED = "color:#888;font-size:12px;margin:4px 0"

/** A plain string is escaped. `{ html }` is passed through, so the caller must
 *  escape whatever it interpolates — used for multi-line cells. */
export type Cell = string | { html: string }

const cell = (c: Cell) => (typeof c === "string" ? escapeHtml(c) : c.html)

export function table(headers: string[], rows: Cell[][], numericFrom = 1): string {
  if (rows.length === 0) return `<p style="${MUTED}">Nothing today.</p>`
  const align = (i: number) => (i >= numericFrom ? ";text-align:right" : "")
  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr>${headers.map((h, i) => `<th style="${TH}${align(i)}">${escapeHtml(h)}</th>`).join("")}</tr>
      ${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${TD}${align(i)}">${cell(c)}</td>`).join("")}</tr>`).join("")}
    </table>`
}


/** A failed section is stated, not hidden — a missing number reads as a zero. */
function block<T>(title: string, s: Section<T>, render: (data: T) => string): string {
  const body = s.ok
    ? render(s.data)
    : `<p style="${MUTED};color:#b45309">Unavailable — ${escapeHtml(s.error)}</p>`
  return `<h3 style="${TITLE}">${escapeHtml(title)}</h3>${body}`
}

/** A labelled sub-block, so three empty ones don't read as one "Nothing today". */
function sub<T>(label: string, s: Section<T>, render: (data: T) => string): string {
  const body = s.ok
    ? render(s.data)
    : `<p style="${MUTED};color:#b45309">Unavailable — ${escapeHtml(s.error)}</p>`
  return `<p style="margin:12px 0 4px;font-weight:600;font-size:13px">${escapeHtml(label)}</p>${body}`
}

/** A headline figure. `null` when its section failed, so it reads "—" not "0". */
function tile(label: string, value: number | null): string {
  return `
    <td style="padding:10px 14px;border:1px solid #eee;border-radius:6px;text-align:center;width:25%">
      <div style="font-size:22px;font-weight:700;line-height:1.2">${value === null ? "—" : num(value)}</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.4px">${escapeHtml(label)}</div>
    </td>`
}

export function renderDigest(d: DigestData): string {
  const sum = <T>(s: Section<T[]>, f: (r: T) => number) =>
    s.ok ? s.data.reduce((a, r) => a + f(r), 0) : null
  const poTotal = sum(d.pos, (r) => r.cnt)

  const summary = `
  <table style="width:100%;border-collapse:separate;border-spacing:6px 0;margin:14px 0 4px">
    <tr>
      ${tile("POs raised", poTotal)}
      ${tile("POs mailed", d.posMailed.ok ? d.posMailed.data : null)}
      ${tile("Emails sent", d.emails.ok ? d.emails.data.flows.reduce((a, f) => a + f.sent, 0) : null)}
      ${tile("Approvals pending", sum(d.approvalsPending, (r) => r.pending))}
    </tr>
  </table>`

  const mailFailed = d.emails.ok ? d.emails.data.flows.reduce((a, f) => a + f.failed, 0) : 0

  return `
<div style="font-family:sans-serif;max-width:720px;margin:auto;color:#111;font-size:14px;line-height:1.5">
  <h2 style="margin:0 0 2px">ERP daily report</h2>
  <p style="${MUTED};margin-top:0">${escapeHtml(d.day)} · 00:00–23:59 IST</p>
  ${summary}
  ${mailFailed > 0
    ? `<p style="margin:10px 0;padding:8px 12px;border-left:3px solid #b45309;background:#fffbeb;font-size:13px">
         <strong>${num(mailFailed)} ${mailFailed === 1 ? "email" : "emails"} failed to send today.</strong>
         See the Emails fired table below.
       </p>`
    : ""}

  ${block("Purchase orders raised today", d.pos, (rows) =>
    table(["Status", "POs"], rows.map((r) => [r.status, num(r.cnt)])) +
    `<p style="${MUTED}">${poTotal ? num(poTotal) + " total. " : ""}` +
    `A PO shows as <strong>Draft</strong> until its mail goes out, which is the same rule PO Tracking uses. ` +
    `The <em>POs mailed</em> figure above counts first sends only, so re-sending a PO does not inflate it. ` +
    `Split children are not counted separately.</p>`
  )}

  ${block("Emails fired", d.emails, (e) =>
    table(["Flow", "Sent", "Failed", "Recipients"],
      e.flows.map((f) => [f.flow, num(f.sent), num(f.failed), num(f.recipients)])) +
    `<p style="${MUTED}">${e.truncated ? "Counts are a lower bound — the log scan hit its page cap. " : ""}` +
    (e.providers.length > 1
      ? `<strong>The mail provider changed today (${escapeHtml(e.providers.join(" then "))}), so these counts span both.</strong> `
      : e.providers.length === 1 ? `Sent via ${escapeHtml(e.providers[0])}. ` : "") +
    `Send-side only: this is whether we handed the mail to the provider, not whether it was delivered.</p>`
  )}

  <h3 style="${TITLE}">Approvals</h3>
  ${sub("Raised today", d.approvalsRaised, (rows) =>
    table(["Module", "Count"], rows.map((r) => [r.module, num(r.cnt)]))
  )}
  ${sub("Decided today", d.approvalsDecided, (rows) =>
    table(["Module", "Outcome", "Count"], rows.map((r) => [r.module, r.status, num(r.cnt)]))
  )}
  ${sub("Still pending", d.approvalsPending, (rows) =>
    table(["Module", "Pending", "Oldest (h)"],
      rows.map((r) => [r.module, num(r.pending), num(r.oldest_hours)]))
  )}

  ${block("Invoices inwarded today", d.invoices, (rows) =>
    table(["Uniware status", "Invoices"], rows.map((r) => [r.uniware_status, num(r.cnt)]))
  )}

  <h3 style="${TITLE}">What this report cannot see</h3>
  <ul style="${MUTED};padding-left:18px">
    <li>Per-row failures inside a bulk CSV upload — a partly-applied batch reads as a success.</li>
    <li>Whether an email was actually delivered, bounced or opened.</li>
  </ul>

  <p style="font-size:12px;color:#888;margin-top:20px">
    Auto-generated by the mcaffeine ERP at 23:59 IST. To change who receives this,
    edit the <strong>report</strong> contacts under PO Procurement &rsaquo; Entity Emails.
  </p>
</div>`
}




