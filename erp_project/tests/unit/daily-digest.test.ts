// The digest's two silent failure modes: a window covering the wrong day, and a
// section vanishing from the mail instead of saying it failed.
//
// lib/cron/jobs.ts is not imported — it reaches lib/db and lib/mail/mailer,
// which throw at import without credentials.

import { istDayWindowUtc, sqlTs, todayIST } from "@/lib/date"
import { renderDigest, type DigestData } from "@/lib/reports/digest-html"
import { test } from "node:test"
import assert from "node:assert/strict"

test("an IST day maps to the UTC window the DB actually stores", () => {
  const { from, to } = istDayWindowUtc("2026-09-28")
  // IST is UTC+5:30, so an IST day starts at 18:30 UTC the PREVIOUS date.
  assert.equal(from.toISOString(), "2026-09-27T18:30:00.000Z")
  assert.equal(to.toISOString(), "2026-09-28T18:30:00.000Z")
  assert.equal(sqlTs(from), "2026-09-27 18:30:00")
})

test("the window is half-open, so consecutive days neither overlap nor gap", () => {
  const a = istDayWindowUtc("2026-09-28")
  const b = istDayWindowUtc("2026-09-29")
  assert.equal(a.to.getTime(), b.from.getTime())
  assert.equal(a.to.getTime() - a.from.getTime(), 86_400_000)
})

test("a PO raised at 23:30 IST falls in that day, not the next", () => {
  // The assertion the whole timezone section exists to protect: 23:30 IST on the
  // 28th is 18:00 UTC on the 28th, which is BEFORE the 28th's window closes.
  const { from, to } = istDayWindowUtc("2026-09-28")
  const at = new Date("2026-09-28T23:30:00+05:30")
  assert.ok(at >= from && at < to, "23:30 IST must land inside its own IST day")
  assert.ok(at >= new Date("2026-09-28T17:59:00Z"), "sanity: it is an evening UTC instant")
})

test("month and year boundaries do not shift the day", () => {
  assert.equal(istDayWindowUtc("2026-01-01").from.toISOString(), "2025-12-31T18:30:00.000Z")
  assert.equal(istDayWindowUtc("2026-03-01").from.toISOString(), "2026-02-28T18:30:00.000Z")
})

test("todayIST is the shape istDayWindowUtc parses", () => {
  const { from } = istDayWindowUtc(todayIST())
  assert.ok(!Number.isNaN(from.getTime()), "todayIST must round-trip through the window helper")
})

const section = <T>(data: T) => ({ ok: true as const, data })

function fixture(): DigestData {
  return {
    day: "2026-09-28",
    pos: section([{ status: "draft", cnt: 3 }, { status: "raised", cnt: 7 }]),
    posMailed: section(7),
    emails: section({ flows: [{ flow: "po_selection", sent: 4, failed: 1, recipients: 9 }], providers: ["ses"], truncated: false }),
    approvalsRaised: section([{ module: "PO", cnt: 2 }]),
    approvalsDecided: section([{ module: "PO", status: "approved", cnt: 1 }]),
    approvalsPending: section([{ module: "SKU", pending: 5, oldest_hours: 30 }]),
    invoices: section([{ uniware_status: "not_pushed", cnt: 2 }]),
  }
}

test("a failed section is stated in the mail, not silently dropped", () => {
  const data = { ...fixture(), emails: { ok: false as const, error: "GetLogEvents denied" } }
  const html = renderDigest(data)
  assert.match(html, /Unavailable/, "a failed section must say so")
  assert.match(html, /GetLogEvents denied/)
  // The rest of the report still has to go out.
  assert.match(html, /Purchase orders raised today/)
  assert.match(html, /Invoices inwarded today/)
})

test("the report carries no request-level detail — wrong register for this audience", () => {
  // Removed 2026-09-28. These go to people without /observability, so route
  // names, HTTP statuses and latency have no place in the mail.
  const html = renderDigest(fixture())
  for (const gone of [/Operations attempted/, /Request volume/, /p95/, /\bHTTP\b/, /Mutations/]) {
    assert.doesNotMatch(html, gone)
  }
})

test("the headline tiles carry the four figures, and a failed one reads '—' not 0", () => {
  const html = renderDigest(fixture())
  for (const label of ["POs raised", "POs mailed", "Emails sent", "Approvals pending"]) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, />10</, "POs raised should total 3 + 7")

  // A section that failed must not render as a confident zero.
  const broken = renderDigest({ ...fixture(), posMailed: { ok: false, error: "db down" } })
  assert.match(broken, /—<\/div>\s*<div[^>]*>POs mailed/, "a failed tile shows an em dash")
})

test("a failed send is called out at the top, not left in a table", () => {
  assert.match(renderDigest(fixture()), /1 email failed to send today/)
  const clean = renderDigest({
    ...fixture(),
    emails: section({ flows: [{ flow: "po_selection", sent: 4, failed: 0, recipients: 9 }], providers: ["ses"], truncated: false }),
  })
  assert.doesNotMatch(clean, /failed to send today/, "no banner when nothing failed")
})

test("a truncated email scan reads as a lower bound, not as the total", () => {
  const data = fixture()
  assert.doesNotMatch(renderDigest(data), /lower bound/)
  data.emails = section({ flows: [{ flow: "po_selection", sent: 4, failed: 1, recipients: 9 }], providers: ["ses"], truncated: true })
  assert.match(renderDigest(data), /lower bound/)
})

test("values are HTML-escaped — a route or error string cannot inject markup", () => {
  const data = { ...fixture(), approvalsRaised: { ok: false as const, error: '<script>alert("x")</script>' } }
  const html = renderDigest(data)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test("a provider switch mid-day is called out, not silently merged", () => {
  const one = renderDigest(fixture())
  assert.match(one, /Sent via ses/)
  assert.doesNotMatch(one, /provider changed/)

  const both = renderDigest({
    ...fixture(),
    emails: section({
      flows: [{ flow: "po_selection", sent: 4, failed: 0, recipients: 9 }],
      providers: ["gmail", "ses"],
      truncated: false,
    }),
  })
  assert.match(both, /provider changed today \(gmail then ses\)/)
})
