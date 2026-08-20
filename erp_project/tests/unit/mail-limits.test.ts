// The attachment ceiling is what stops a large PO selection from being handed to
// SES as an oversized raw message. SES's rejection carries nothing actionable, so
// if this guard is wrong the operator sees an opaque failure on a send that looked
// fine — and the POs silently don't reach the manufacturer.
import { test } from "node:test"
import assert from "node:assert/strict"
import { assertAttachmentsWithinLimit, MAX_ATTACHMENT_BYTES } from "../../lib/mail/mail-limits"

const att = (bytes: number, filename = "PO-1.pdf") =>
  ({ filename, content: Buffer.alloc(bytes) })

test("no attachments passes", () => {
  assert.doesNotThrow(() => assertAttachmentsWithinLimit([], "selection"))
})

test("a single attachment under the limit passes", () => {
  assert.doesNotThrow(() => assertAttachmentsWithinLimit([att(1024 * 1024)], "selection"))
})

test("exactly at the limit passes — the check is > not >=", () => {
  // Boundary matters: a message sized exactly at the budget is still sendable,
  // and an off-by-one here would reject a legitimate send.
  assert.doesNotThrow(() =>
    assertAttachmentsWithinLimit([att(MAX_ATTACHMENT_BYTES)], "selection")
  )
})

test("one byte over the limit throws", () => {
  assert.throws(() => assertAttachmentsWithinLimit([att(MAX_ATTACHMENT_BYTES + 1)], "selection"))
})

test("size is summed across attachments, not checked per file", () => {
  // The real failure mode: many individually-small PO PDFs. Checking each file in
  // isolation would pass all of them and still produce an oversized message.
  const MB = 1024 * 1024
  const twenty = Array.from({ length: 20 }, (_, i) => att(MB, `PO-${i}.pdf`))
  assert.doesNotThrow(() => assertAttachmentsWithinLimit(twenty, "selection"))

  // 29 × 1 MB — every file is trivially small, the total is not.
  const twentyNine = Array.from({ length: 29 }, (_, i) => att(MB, `PO-${i}.pdf`))
  assert.throws(() => assertAttachmentsWithinLimit(twentyNine, "selection"))
})

test("the error names the count, the size and the caller's context", () => {
  // The message is the whole point — it is what an operator reads when a send is
  // refused, and it has to say what to do about it.
  assert.throws(
    () => assertAttachmentsWithinLimit([att(MAX_ATTACHMENT_BYTES + 1)], "PO selection email for MFG-014"),
    (err: unknown) => {
      const m = (err as Error).message
      assert.match(m, /PO selection email for MFG-014/)
      assert.match(m, /1 attachments/)
      assert.match(m, /28\.0 MB limit/)
      assert.match(m, /smaller batches/)
      return true
    }
  )
})
