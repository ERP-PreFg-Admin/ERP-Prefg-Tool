// S3 key authorization — the pure half of lib/s3-guard.ts.
//
// What must not break: the uploader marker is the ONLY thing that lets a key be
// read without a DB owner, so a caller must not be able to forge someone else's
// marker through the `field` they send to /api/v1/upload. The owner lookup itself is
// exercised in tests/db/s3-key-owners.test.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { uploadedBy, buildUploadKey } from "../../lib/s3-guard"

test("a key built for a user reads back as that user's", () => {
  const key = buildUploadKey("invoices/202608", "invoice", "pdf", 42)
  assert.equal(uploadedBy(key), 42)
})

test("the key keeps its folder and extension, so import/preview still work", () => {
  const key = buildUploadKey("imports/RM/202608", "csv_source", "csv", 7)
  assert.ok(key.startsWith("imports/RM/202608/csv_source-u7-"))
  assert.ok(key.endsWith(".csv"), "lib/import-s3.ts picks the parser off the extension")
})

test("two uploads of the same folder+field never produce the same key", () => {
  // This is the whole overwrite fix: uploadFile is a PutObject, so a repeated key
  // replaces the object that was already there.
  const a = buildUploadKey("vendors/tmp/x", "pan_card_key", "pdf", 1)
  const b = buildUploadKey("vendors/tmp/x", "pan_card_key", "pdf", 1)
  assert.notEqual(a, b)
})

test("a key with no marker belongs to nobody", () => {
  // Every key written before this existed. Those are readable only through their
  // owning row, which is the point.
  assert.equal(uploadedBy("invoices/202607/invoice.pdf"), null)
  assert.equal(uploadedBy("po-attachments/MCAFF-PO-001.pdf"), null)
})

test("a marker cannot be forged through the caller-supplied field", () => {
  // `field` reaches /api/v1/upload from the browser. A caller sending
  // field="doc-u42-abc" gets their OWN id appended after it, and the regex is
  // anchored to the end — so the real marker is the only one read.
  const key = buildUploadKey("vendors/tmp/x", "doc-u42-aaaaaaaaaaaa", "pdf", 9)
  assert.equal(uploadedBy(key), 9, "the trailing marker wins, not the smuggled one")
})

test("another user's key is not readable as your own on a digit prefix", () => {
  // id 1 must not match a key uploaded by id 15.
  const key = buildUploadKey("vendors/tmp/x", "gst_certificate_key", "pdf", 15)
  assert.equal(uploadedBy(key), 15)
  assert.notEqual(uploadedBy(key), 1)
})

test("a hand-crafted key that only looks like a marker is rejected", () => {
  // The token is exactly 12 hex chars; a guessed suffix that isn't gets no marker.
  assert.equal(uploadedBy("x/doc-u3-nothex.pdf"), null)
  assert.equal(uploadedBy("x/doc-u3-abc.pdf"), null)
  assert.equal(uploadedBy("x/doc-u3-aaaaaaaaaaaa"), null, "no extension, no match")
})
