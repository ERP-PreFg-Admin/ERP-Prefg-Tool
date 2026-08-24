/** The response envelope every Uniware endpoint shares: HTTP 200 with
 *  `successful: false` is how a business failure is reported, so `res.ok` is
 *  never a success check. */
export type ExportEnvelope = {
  successful?: boolean
  message?: string
  errors?: { description?: string; message?: string }[]
  warnings?: { description?: string; message?: string }[]
}

/** Uniware's error text, however it chose to report it. */
export function envelopeError(data: ExportEnvelope, status: number, fallback: string): string {
  const msgs = (data.errors ?? []).map((e) => e.description || e.message).filter(Boolean)
  return msgs.join("; ") || data.message || `${fallback} (HTTP ${status})`
}
