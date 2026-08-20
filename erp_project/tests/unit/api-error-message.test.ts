// withGateway sends field-level validation detail and every caller was reading
// only `data.error`, so a mistyped email address reported "Invalid request".
// These pin the precedence: the most specific message available wins.
import { test } from "node:test"
import assert from "node:assert/strict"
import { apiErrorMessage } from "../../lib/api-error-message"

test("a field error beats the generic top-level message", () => {
  // The actual reported bug: this body produced "Invalid request".
  const body = {
    error: "Invalid request",
    code: "validation_error",
    details: { formErrors: [], fieldErrors: { emails: ["Invalid email address"] } },
  }
  assert.equal(apiErrorMessage(body), "emails: Invalid email address")
})

test("several field errors are all reported, not just the first", () => {
  const body = {
    error: "Invalid request",
    details: { fieldErrors: { email: ["Invalid email address"], entity_code: ["Required"] } },
  }
  const msg = apiErrorMessage(body)
  assert.match(msg, /Invalid email address/)
  assert.match(msg, /Required/)
})

test("form-level errors are used when there are no field errors", () => {
  // Where a Zod .refine() with no `path` lands.
  const body = {
    error: "Invalid request",
    details: { formErrors: ["A legal entity can only be set on warehouse contacts."], fieldErrors: {} },
  }
  assert.equal(apiErrorMessage(body), "A legal entity can only be set on warehouse contacts.")
})

test("the top-level error is used when there is no detail", () => {
  // Non-validation failures: our own ApiError messages, which are already written
  // for a human.
  const body = { error: "'a@b.com' is already on file for this contact.", code: "duplicate_email" }
  assert.equal(apiErrorMessage(body), "'a@b.com' is already on file for this contact.")
})

test("the fallback is used when the body carries nothing usable", () => {
  assert.equal(apiErrorMessage({}, "Failed to save."), "Failed to save.")
  assert.equal(apiErrorMessage(null, "Failed to save."), "Failed to save.")
  assert.equal(apiErrorMessage(undefined, "Failed to save."), "Failed to save.")
})

test("empty and blank messages are ignored rather than shown", () => {
  // An empty array or a whitespace string would otherwise surface as a blank
  // error box — visibly broken, and worse than the fallback.
  assert.equal(apiErrorMessage({ error: "   " }, "Failed to save."), "Failed to save.")
  assert.equal(
    apiErrorMessage({ error: "Invalid request", details: { fieldErrors: { email: [] } } }),
    "Invalid request"
  )
})

test("malformed details are tolerated, never thrown on", () => {
  // details is whatever the server put there; a client must not crash on a shape
  // it didn't expect, or a bad error response becomes a blank screen.
  assert.equal(apiErrorMessage({ error: "X", details: "not an object" }), "X")
  assert.equal(apiErrorMessage({ error: "X", details: { fieldErrors: null } }), "X")
  assert.equal(apiErrorMessage({ error: "X", details: { fieldErrors: { a: "str" } } }), "X")
})
