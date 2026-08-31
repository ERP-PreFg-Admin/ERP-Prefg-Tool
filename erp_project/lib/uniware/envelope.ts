/** The response envelope every Uniware endpoint shares: HTTP 200 with
 *  `successful: false` is how a business failure is reported, so `res.ok` is
 *  never a success check. */
export type ExportEnvelope = {
  successful?: boolean
  message?: string
  errors?: { code?: number; fieldName?: string; description?: string; message?: string }[]
  warnings?: { description?: string; message?: string }[]
}

/**
 * Jackson appends the raw request stream to its deserialization errors:
 *
 *   Unrecognized field "foo" (Class com.uniware…Request), not marked as ignorable
 *    at [Source: org.springframework…ContentCachingInputStream@3bcefde6; line: 1, column: 16]
 *
 * The first line is the answer; the rest is an object address and an offset into
 * a body we already have. Cutting it keeps the useful half readable in a toast.
 */
function trimSource(s: string): string {
  return s.split(/\s+at \[Source:/)[0].trim()
}

/**
 * Uniware's error text, however it chose to report it.
 *
 * ⚠️ `description` alone is NOT enough, and assuming it was cost real debugging
 * time on 2026-08-28: for a **code 1000** (deserialization) failure the
 * description is the useless generic `"please fill valid value"` while `message`
 * carries the actual cause — the unrecognized field, or the type that could not
 * be read. Four rejected gatepass lines all reported "please fill valid value"
 * and nothing else, which named neither the field nor the reason.
 *
 * So both are kept whenever they differ. They are usually identical for ordinary
 * business errors ("Atleast one Gate pass code should be present"), in which case
 * this reads exactly as it did before.
 */
export function envelopeError(data: ExportEnvelope, status: number, fallback: string): string {
  const msgs = (data.errors ?? [])
    .map((e) => {
      const description = e.description?.trim() ?? ""
      const detail = trimSource(e.message?.trim() ?? "")
      // `fieldName` is populated on MISSING_REQUIRED_PARAMETERS and is the single
      // most actionable thing in the payload when it is there.
      const field = e.fieldName ? `${e.fieldName}: ` : ""
      if (description && detail && detail !== description) return `${field}${description} — ${detail}`
      return `${field}${description || detail}`
    })
    .filter((s) => s.trim() !== "")

  return msgs.join("; ") || data.message || `${fallback} (HTTP ${status})`
}
