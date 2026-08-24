/**
 * Making Unicommerce's failures readable.
 *
 * ── THIS FILE MUST IMPORT NOTHING ───────────────────────────────────────────
 * It is the only part of lib/uniware/ that CLIENT components use —
 * MfgFacilityMapPanel.tsx and SyncUniwareButton.tsx (via
 * app/po-tracking/sync-summary.ts) are both "use client". Every other file in
 * this folder reaches @/lib/env, and so UNIWARE_PASSWORD / UNIWARE_USER_NAME;
 * one import here would open a path that drags those into a client bundle.
 *
 * Zero imports is what makes that impossible rather than merely discouraged.
 * Two things hold the line, because a convention would not:
 *   - `tests/unit/uniware-error.test.ts` asserts this file has no imports.
 *   - eslint.config.mjs stops app/** (outside app/api) importing the
 *     "@/lib/uniware" barrel at all — UI reaches for @/lib/uniware/errors.
 * It is deliberately NOT re-exported from index.ts, for the same reason.
 *
 * Being pure is also why it is the one part of the integration testable with no
 * credentials: the four transport tests need `await import(...)` inside the test
 * body because @/lib/env reads process.env at module load.
 *
 * Two problems this solves, both visible on screen before it existed:
 *
 *  1. **The wrong story.** Uniware reports BUSINESS failures as HTTP 200 with
 *     `successful: false` (see the header of lib/uniware.ts). So a real 4xx/5xx
 *     is transport, auth or facility — never "no such record". The old fallback
 *     said `Uniware returned no purchase order 0020 (HTTP 403)`, which sent
 *     people hunting for a missing PO when the account simply wasn't allowed to
 *     ask. `uniwareStatusFallback` is that distinction.
 *
 *  2. **Raw payloads on screen.** The thrown strings paste the response body
 *     into the message (`raw.slice(0, 300)`), so a 502 from their load balancer
 *     put 300 characters of `<html><head><title>502 Bad Gateway` into a toast,
 *     and an auth failure put a JSON envelope there. `uniwareErrorReasons`
 *     unwraps that back into sentences.
 *
 * Pure on purpose — no fetch, no env, no db — so tests/unit can cover it without
 * credentials, the same reason lib/api-error-message.ts is a module of its own.
 *
 * The raw text is NOT sanitised before storage: `un_push_error` and
 * `logger.warn` keep exactly what Uniware said, because that is the only copy of
 * it. Cleaning happens here, at the point of display.
 */

/** One reason should fit a line of UI, not a paragraph of someone's stack trace. */
const MAX_REASON = 200

/** Wrappers lib/uniware.ts puts in front of a pasted-in response body. */
const WRAPPERS = [
  /^Uniware returned non-JSON \(HTTP (\d+)\):\s*/i,
  /^Uniware auth failed:\s*/i,
  /^Uniware returned an empty response \(HTTP (\d+)\)\s*/i,
]

/** A response body that is a web page, not an API reply. */
const LOOKS_LIKE_HTML = /<\s*(!doctype|html|head|body|title|p|div|center)\b/i

const squash = (s: string) => s.replace(/\s+/g, " ").trim()

const clip = (s: string) =>
  s.length > MAX_REASON ? `${s.slice(0, MAX_REASON - 1).trimEnd()}…` : s

/**
 * What to say when Uniware refuses but names no reason of its own.
 *
 * `subject` reads inside the sentence, so pass the noun phrase — "purchase order
 * 0020", not just the code.
 *
 * It is deliberately NOT used by every branch. Only a failure that is genuinely
 * about the record names it (404, and the catch-all); an account or
 * infrastructure failure must not, for the two reasons in the 401/403 branch
 * below. `tests/unit/uniware-error.test.ts` pins both halves of that split —
 * re-adding the subject to an account/outage message breaks three tests.
 */
export function uniwareStatusFallback(subject: string, status: number): string {
  if (status === 401 || status === 403) {
    // Deliberately WITHOUT the subject, for two reasons:
    //
    //   1. A refused account is refused for EVERY record, so naming one implies
    //      that record is at fault. This is the exact regression from the
    //      2026-08-21 screenshot — "returned no purchase order 0020 (HTTP 403)"
    //      sent people hunting a PO that was there all along, when the real
    //      cause was the EC2 egress IP not being allowlisted by Unicommerce.
    //   2. It breaks grouping. failureReasons() in app/po-tracking/sync-summary.ts
    //      groups by reason, so five POs refused by one token only read as one
    //      problem while the five messages are byte-identical.
    //
    // Both causes are named because the endpoint is facility-scoped: the right
    // credentials asking about the wrong facility fail exactly like the wrong
    // credentials.
    return "Not authorised — check the Uniware credentials, and that the record's facility matches the one being asked."
  }
  if (status === 404) return `Uniware has no ${subject}.`
  if (status === 429) return `Uniware is rate-limiting this account — retry in a moment.`
  if (status >= 500) return `Uniware is unavailable (HTTP ${status}) — their end, not ours. Retry later.`
  return `Uniware gave no status for ${subject} (HTTP ${status}).`
}

/** `{ errors: [{ description }] }`, the envelope every Uniware endpoint shares. */
function envelopeReasons(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const errors = (value as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []
  return errors
    .map((e) => {
      if (!e || typeof e !== "object") return typeof e === "string" ? e : ""
      const o = e as { description?: unknown; message?: unknown }
      return typeof o.description === "string" && o.description.trim()
        ? o.description
        : typeof o.message === "string"
          ? o.message
          : ""
    })
    .filter((s) => s.trim() !== "")
}

/**
 * The distinct human reasons inside one raw Uniware error string.
 *
 * A list, not a sentence: lib/uniware.ts joins several of Uniware's own errors
 * with "; ", and rendering that as one run-on line is half of why these read
 * badly. Empty in, empty out — the caller decides what "no reason given" looks
 * like.
 */
export function uniwareErrorReasons(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return []

  let rest = raw.trim()
  let status: string | null = null
  for (const w of WRAPPERS) {
    const m = rest.match(w)
    if (!m) continue
    if (m[1]) status = m[1]
    rest = rest.slice(m[0].length).trim()
    break
  }

  if (!rest) {
    return [status ? `Uni
      ware returned nothing (HTTP ${status}).` : "Uniware returned nothing."]
  }

  // A web page where JSON belongs is always infrastructure, and the markup tells
  // the reader nothing. Report the fact and drop the body.
  if (LOOKS_LIKE_HTML.test(rest)) {
    return [
      status
        ? `Uniware is unavailable (HTTP ${status}) — it returned a web page instead of a reply.`
        : "Uniware returned a web page instead of a reply.",
    ]
  }

  // An envelope that survived being stringified into the message.
  if (rest.startsWith("{") || rest.startsWith("[")) {
    try {
      const parsed = JSON.parse(rest)
      const reasons = envelopeReasons(parsed)
      if (reasons.length > 0) return dedupe(reasons)
      // Valid JSON, no `errors` — say so rather than printing the object.
      return [status ? `Uniware refused it without giving a reason (HTTP ${status}).` : "Uniware refused it without giving a reason."]
    } catch {
      // Truncated at 300 chars by the thrower, so a half-object is expected.
      return [status ? `Uniware sent a malformed reply (HTTP ${status}).` : "Uniware sent a malformed reply."]
    }
  }

  // Already prose. Several of Uniware's own errors arrive "; "-joined.
  return dedupe(rest.split(/\s*;\s+/))
}

function dedupe(reasons: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of reasons) {
    const clean = clip(squash(r))
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/**
 * One line, for somewhere that can only show one — a `title=` tooltip, a log
 * field. Prefer `uniwareErrorReasons` anywhere with room for a list.
 */
export function uniwareErrorMessage(
  raw: string | null | undefined,
  fallback: string | null = null
): string | null {
  const reasons = uniwareErrorReasons(raw)
  return reasons.length > 0 ? reasons.join(" · ") : fallback
}
