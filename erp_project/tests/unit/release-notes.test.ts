import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCommit, buildNotes, stampNotes } from "../../deploy/release-notes.mjs"

test("parseCommit: feat is New, fix and perf are Fixed, with the screen name", () => {
  assert.deepEqual(parseCommit("feat(po): choose the supplier unit per line when splitting a PO"),
    { kind: "new", area: "PO Tracking", text: "Choose the supplier unit per line when splitting a PO" })
  assert.deepEqual(parseCommit("fix(invoice): read Jainam's qty and rate the right way round."),
    { kind: "fixed", area: "Invoices", text: "Read Jainam's qty and rate the right way round" })
  assert.equal(parseCommit("perf(invoices): cache parses")?.kind, "fixed")
})

test("parseCommit: internal types, scopes and freeform messages are dropped", () => {
  for (const s of ["refactor(po): move reads", "chore: tidy", "docs: plan", "ci: drop test", "Minor chnage",
    "fix(lint): rename var", "fix(deploy): scope limit", "feat(cron): hourly runner", "Merge branch 'main'"]) {
    assert.equal(parseCommit(s), null, s)
  }
})

test("parseCommit: Release-note trailer rewrites or hides a commit", () => {
  assert.equal(parseCommit("fix(po): NDJSON stream fix", "Release-note: Saving an invoice no longer hangs")?.text,
    "Saving an invoice no longer hangs")
  assert.equal(parseCommit("feat(po): something", "Body\n\nRelease-note: skip"), null)
})

test("parseCommit: unknown or multi scopes", () => {
  assert.equal(parseCommit("feat(widgets): x")?.area, "")
  assert.equal(parseCommit("feat(admin,approvals): x")?.area, "Admin")
  assert.equal(parseCommit("feat: no scope")?.area, "")
})

test("buildNotes: a commit applied twice shows once", () => {
  const n = buildNotes("v1.2.3", "2026-10-30", [
    { subject: "feat(uniware): sync PO documents both ways", body: "" },
    { subject: "feat(uniware): sync PO documents both ways", body: "" },
    { subject: "chore: x", body: "" },
  ])
  assert.equal(n.version, "v1.2.3")
  assert.equal(n.items.length, 1)
})

test("stampNotes: ships reviewed notes only for the release they were written for", () => {
  const next = { from: "v0.1.26", items: [{ kind: "new", area: "PO Tracking", text: "Pick the plant when splitting" }, { kind: "x", text: "bad" }] }
  const ok = stampNotes(next, "v0.1.26", "v0.1.27", "2026-10-30")
  assert.equal(ok.warning, null)
  assert.deepEqual(ok.notes, { version: "v0.1.27", date: "2026-10-30", items: [next.items[0]] })

  const stale = stampNotes(next, "v0.1.27", "v0.1.28", "2026-11-05")
  assert.equal(stale.notes.items.length, 0, "last release's notes must not show again")
  assert.ok(stale.warning)
  assert.equal(stampNotes(null, "v0.1.26", "v0.1.27", "x").notes.items.length, 0)
})
