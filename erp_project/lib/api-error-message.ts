/**
 * Turning an API error body into something a user can act on.
 *
 * withGateway already sends field-level detail on a validation failure —
 * `ApiError(400, "validation_error", "Invalid request", parsed.error.flatten())`
 * — but every caller reads only `data.error`, so the useful half is discarded and
 * the user is told "Invalid request" for a mistyped email address. That is the
 * whole reason this exists.
 *
 * Pure, so it can be unit-tested without a server: it takes the parsed JSON body.
 */

/** Zod's `.flatten()` shape, which is what withGateway puts in `details`. */
type Flattened = {
  formErrors?: unknown
  fieldErrors?: Record<string, unknown>
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []

/**
 * The best message available in an error response.
 *
 * Prefers the specific over the general: field messages, then form-level ones,
 * then the top-level `error`, then the caller's fallback. A validation failure
 * therefore reads "Invalid email address" rather than "Invalid request".
 *
 * Field names are included because a form can have several inputs and "Invalid
 * email address" alone doesn't say which. `emails` is Zod's key for a nested
 * path — `.flatten()` groups by the FIRST path segment, so an error at
 * emails[0].email lands under `emails`.
 */
export function apiErrorMessage(data: unknown, fallback = "Request failed"): string {
  const body = (data ?? {}) as { error?: unknown; details?: unknown }
  const details = (body.details ?? {}) as Flattened

  const fieldMessages: string[] = []
  if (details.fieldErrors && typeof details.fieldErrors === "object") {
    for (const [field, msgs] of Object.entries(details.fieldErrors)) {
      for (const m of strings(msgs)) fieldMessages.push(`${field}: ${m}`)
    }
  }
  if (fieldMessages.length > 0) return fieldMessages.join("; ")

  const formMessages = strings(details.formErrors)
  if (formMessages.length > 0) return formMessages.join("; ")

  if (typeof body.error === "string" && body.error.trim() !== "") return body.error
  return fallback
}
