// The welcome mail: sent once a new user can actually sign in, and says how.
import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldSendWelcome, renderWelcomeMail } from "../../lib/mail/welcome-mail"

test("shouldSendWelcome: created active, or first activated — once", () => {
  const cases: [string | null, string, unknown, boolean, string][] = [
    [null, "active", null, true, "created active"],
    [null, "inactive", null, false, "created inactive — can't sign in yet"],
    ["inactive", "active", null, true, "first activation"],
    ["active", "active", null, false, "an edit that keeps it active"],
    ["inactive", "active", new Date(), false, "already welcomed before deactivation"],
    [null, "active", "2026-10-08 10:00:00", false, "already sent"],
    ["active", "inactive", null, false, "deactivation"],
  ]
  for (const [before, after, sent, want, why] of cases) {
    assert.equal(shouldSendWelcome({ before, after, welcomeSentAt: sent }), want, why)
  }
})

const mail = (o: Partial<Parameters<typeof renderWelcomeMail>[0]> = {}) =>
  renderWelcomeMail({ name: "Riya", email: "riya@mcaffeine.com", appUrl: "https://erp.mcaffeine.com/", admin: { name: "Ajay Singh", email: "ajay.singh@mcaffeine.com" }, ...o })

test("renderWelcomeMail: link, sign-in email and contact are all there", () => {
  const m = mail()
  assert.equal(m.subject, "Welcome to PEP ERP")
  for (const part of [m.html, m.text]) {
    assert.ok(part.includes("https://erp.mcaffeine.com"), "link")
    assert.ok(!part.includes("mcaffeine.com/\""), "trailing slash trimmed")
    assert.ok(part.includes("riya@mcaffeine.com"), "the email to sign in with")
    assert.ok(part.includes("Ajay Singh") && part.includes("ajay.singh@mcaffeine.com"), "who to contact")
    assert.match(part, /no password is needed/)
  }
})

test("renderWelcomeMail: names are escaped in the HTML", () => {
  const m = mail({ name: `<script>x</script>`, admin: { name: `O"Neil & Co`, email: "a@b.c" } })
  assert.ok(!m.html.includes("<script>"))
  assert.ok(m.html.includes("&lt;script&gt;"))
  assert.ok(m.html.includes("O&quot;Neil &amp; Co"))
})
