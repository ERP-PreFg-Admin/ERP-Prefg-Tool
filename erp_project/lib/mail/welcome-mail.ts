// The welcome mail a new ERP user gets: when it goes, and what it says. Pure —
// sending lives in lib/mail/mailer.ts. See docs/welcome-mail-plan.md.

type Status = string | null | undefined

/** Sent once a user can sign in: created active, or first switched inactive → active.
 *  Resend bypasses this on purpose. */
export function shouldSendWelcome(o: { before: Status; after: Status; welcomeSentAt: unknown }): boolean {
  if (o.after !== "active" || o.welcomeSentAt) return false
  return o.before == null || o.before === "inactive"
}

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

export function renderWelcomeMail(o: {
  name: string
  email: string
  appUrl: string
  admin: { name: string; email: string }
}): { subject: string; html: string; text: string } {
  const url = o.appUrl.replace(/\/+$/, "")
  const subject = "Welcome to PEP ERP"
  const text = [
    `Hi ${o.name},`,
    "",
    "You've been given access to the PEP ERP.",
    `Sign in at ${url} with "Sign in with Google", using ${o.email} — no password is needed.`,
    "",
    `For access to more pages or any help, contact ${o.admin.name} (${o.admin.email}).`,
  ].join("\n")
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;color:#111;font-size:14px;line-height:1.5">
      <h2 style="margin-bottom:8px">Welcome to PEP ERP</h2>
      <p>Hi ${esc(o.name)},</p>
      <p>You've been given access to the PEP ERP.</p>
      <p>Sign in at <a href="${esc(url)}">${esc(url)}</a> with <strong>Sign in with Google</strong>,
         using <strong>${esc(o.email)}</strong> — no password is needed.</p>
      <p>For access to more pages or any help, contact
         <strong>${esc(o.admin.name)}</strong> (<a href="mailto:${esc(o.admin.email)}">${esc(o.admin.email)}</a>).</p>
      <p style="font-size:12px;color:#888;margin-top:24px">This is an automated email from the mcaffeine ERP system.</p>
    </div>`
  return { subject, html, text }
}
