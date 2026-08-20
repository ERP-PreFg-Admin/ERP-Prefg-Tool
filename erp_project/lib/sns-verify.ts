/**
 * SNS message signature verification.
 *
 * Its own module so it can be unit-tested without loading the route (and through
 * it lib/db). The security of app/api/v1/webhooks/ses/route.ts rests entirely on
 * these two functions, so they are the part worth testing directly.
 *
 * ── Why this is not optional ─────────────────────────────────────────────────
 * The webhook is the only route in the app that cannot use withGateway — SNS has
 * no session. Without signature verification anyone who learns the URL can POST
 * a forged bounce notification and suppress a real manufacturer's address, which
 * is a denial of service on our own purchase orders. The signature is the ONLY
 * thing distinguishing SNS from an attacker.
 */

import crypto from "crypto"

/**
 * Hosts allowed to serve the signing certificate.
 *
 * SNS puts the certificate URL *inside the message body*, so an attacker
 * controls it. Fetching it unchecked turns this endpoint into an SSRF primitive:
 * post a body naming an internal address and the server fetches it — on EC2 that
 * includes the instance metadata service. Validating the host before any network
 * call is what closes that.
 *
 * Anchored at both ends, and the dots are escaped: `sns.x.amazonaws.com.evil.com`
 * must not match.
 */
const SIGNING_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/

export function isAllowedSigningCertUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  // https only — an http cert fetch is trivially interceptable, which would let
  // an on-path attacker substitute their own signing key.
  if (url.protocol !== "https:") return false
  return SIGNING_HOST.test(url.hostname)
}

/**
 * The exact byte string SNS signed, per its documented canonical form: each
 * field as `name\nvalue\n`, in this order, omitting absent optional fields.
 *
 * Field order and set are fixed by AWS and differ per message type — using the
 * wrong set produces a signature mismatch on every legitimate message, so this
 * cannot be "tidied" into iterating the object's own keys.
 */
export function canonicalMessage(msg: Record<string, unknown>): string | null {
  const type = msg.Type
  const fields =
    type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation"
        ? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
        : null
  if (!fields) return null

  let out = ""
  for (const f of fields) {
    const v = msg[f]
    // Subject is optional; a missing field is omitted entirely rather than
    // included as empty, which would change the bytes and fail the check.
    if (v === undefined || v === null) continue
    out += `${f}\n${String(v)}\n`
  }
  return out
}

/**
 * Verify the RSA signature over the canonical form.
 *
 * `fetchCert` is injected so the unit test can exercise the whole path without a
 * network call — and so the SSRF guard above is provably applied before any
 * fetch happens, rather than by convention.
 */
export async function verifySnsSignature(
  msg: Record<string, unknown>,
  fetchCert: (url: string) => Promise<string>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const certUrl = msg.SigningCertURL ?? msg.SigningCertUrl
  if (typeof certUrl !== "string" || !isAllowedSigningCertUrl(certUrl)) {
    return { ok: false, reason: "signing cert URL is missing or not an SNS host" }
  }
  if (typeof msg.Signature !== "string") {
    return { ok: false, reason: "no signature" }
  }

  // SNS still emits SignatureVersion 1 (SHA1) alongside 2 (SHA256). Accept both
  // but nothing else — an unknown version means we cannot say what was signed.
  const version = String(msg.SignatureVersion ?? "1")
  const algo = version === "2" ? "RSA-SHA256" : version === "1" ? "RSA-SHA1" : null
  if (!algo) return { ok: false, reason: `unsupported SignatureVersion ${version}` }

  const canonical = canonicalMessage(msg)
  if (!canonical) return { ok: false, reason: `unsupported message Type ${String(msg.Type)}` }

  let pem: string
  try {
    pem = await fetchCert(certUrl)
  } catch {
    return { ok: false, reason: "could not fetch signing certificate" }
  }

  try {
    const verifier = crypto.createVerify(algo)
    verifier.update(canonical, "utf8")
    const valid = verifier.verify(pem, msg.Signature, "base64")
    return valid ? { ok: true } : { ok: false, reason: "signature did not verify" }
  } catch {
    // A malformed certificate lands here. Treated as a failure, never as a pass.
    return { ok: false, reason: "signature check errored" }
  }
}
