// POST /api/v1/webhooks/ses
//
// SES delivery events, via the SNS topic the `erp-app` configuration set
// publishes to. Permanent bounces and complaints become rows in
// email_suppressions, which resolveRecipients() then filters out of both the To
// and CC lists of every subsequent send.
//
// ── Why this route does NOT use withGateway ──────────────────────────────────
// SNS has no session, so the gateway's auth step would reject every delivery.
// That makes this the only unauthenticated write path in the app, and the
// signature check below is the entire access control. Do not add a shortcut that
// skips it "for testing" — a forged bounce suppresses a real manufacturer's
// address, which is a denial of service on our own purchase orders.
//
// ── Why it returns 200 so readily ────────────────────────────────────────────
// A non-2xx makes SNS retry with backoff and eventually disable the
// subscription, at which point suppression silently stops working while every
// send still looks fine. So anything we understood-and-chose-to-ignore is a 200.
// Only a failed signature is a 403, because that is not SNS talking.

import { NextResponse, type NextRequest } from "next/server"
import { execute } from "@/lib/db"
import { emailSuppressionsSql } from "@/lib/queries/email-suppressions"
import { isAllowedSigningCertUrl, verifySnsSignature } from "@/lib/mail/sns-verify"
import logger from "@/lib/logger"
import crypto from "crypto"

export const runtime = "nodejs"

/** Certificates are immutable per URL, so one fetch per URL per process is
 *  plenty — and it stops a retry storm turning into a fetch storm. */
const certCache = new Map<string, string>()

async function fetchCert(url: string): Promise<string> {
  const hit = certCache.get(url)
  if (hit) return hit
  // Re-checked here as well as in verifySnsSignature: this is the function that
  // actually performs the request, so the guard belongs adjacent to it. Cheap,
  // and it survives someone calling this directly later.
  if (!isAllowedSigningCertUrl(url)) throw new Error("refused non-SNS signing cert host")
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`cert fetch ${res.status}`)
  const pem = await res.text()
  certCache.set(url, pem)
  return pem
}

type SesEvent = {
  eventType?: string
  mail?: { messageId?: string; destination?: string[] }
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[]
  }
  complaint?: {
    complaintFeedbackType?: string
    complainedRecipients?: { emailAddress?: string }[]
  }
}

/**
 * Which addresses this event should suppress, and why.
 *
 * Only permanent bounces and complaints. A Transient bounce (full mailbox,
 * greylisting) returns nothing: permanently disabling a manufacturer's only
 * contact because their inbox was full for an afternoon is worse than the
 * delivery failure it replaces.
 */
function suppressionsFrom(event: SesEvent): { email: string; reason: "bounce" | "complaint"; detail: string | null }[] {
  if (event.eventType === "Bounce" && event.bounce?.bounceType === "Permanent") {
    return (event.bounce.bouncedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((e): e is string => !!e)
      .map((email) => ({
        email,
        reason: "bounce" as const,
        detail: event.bounce?.bounceSubType ?? null,
      }))
  }
  if (event.eventType === "Complaint") {
    return (event.complaint?.complainedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter((e): e is string => !!e)
      .map((email) => ({
        email,
        reason: "complaint" as const,
        detail: event.complaint?.complaintFeedbackType ?? null,
      }))
  }
  return []
}

export async function POST(req: NextRequest) {
  const ctx = { module: "SES_WEBHOOK", requestId: crypto.randomUUID() }

  // Read as text: the signature is over specific fields of the parsed body, and
  // a body that isn't JSON must be rejected rather than crash the handler.
  const raw = await req.text().catch(() => "")
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    logger.warn({ ...ctx, message: "SES webhook: body was not JSON" })
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const verdict = await verifySnsSignature(msg, fetchCert)
  if (!verdict.ok) {
    // The one case that is not a 200. Logged at error because a sustained stream
    // of these is someone probing the endpoint.
    logger.error({ ...ctx, reason: verdict.reason, message: "SES webhook: signature rejected" })
    return NextResponse.json({ ok: false }, { status: 403 })
  }

  const type = String(msg.Type ?? "")

  // SNS confirms a new HTTPS subscription by posting a token here; fetching
  // SubscribeURL is what completes it. Only reached after the signature passed,
  // so an attacker cannot subscribe our endpoint to their own topic.
  if (type === "SubscriptionConfirmation") {
    const url = typeof msg.SubscribeURL === "string" ? msg.SubscribeURL : null
    if (!url || !isAllowedSigningCertUrl(url)) {
      logger.error({ ...ctx, message: "SES webhook: SubscribeURL missing or not an SNS host" })
      return NextResponse.json({ ok: false }, { status: 400 })
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) })
      logger.info({ ...ctx, topicArn: msg.TopicArn, message: "SES webhook: subscription confirmed" })
    } catch (e) {
      logger.error({ ...ctx, error: e instanceof Error ? e.message : String(e), message: "SES webhook: subscription confirmation failed" })
    }
    return NextResponse.json({ ok: true })
  }

  if (type !== "Notification") {
    // UnsubscribeConfirmation and anything future. Acknowledged so SNS does not
    // retry, recorded so an unexpected unsubscribe is visible.
    logger.warn({ ...ctx, type, message: "SES webhook: non-notification message acknowledged" })
    return NextResponse.json({ ok: true })
  }

  let event: SesEvent
  try {
    event = JSON.parse(String(msg.Message))
  } catch {
    logger.warn({ ...ctx, message: "SES webhook: Message payload was not JSON" })
    return NextResponse.json({ ok: true })
  }

  const toSuppress = suppressionsFrom(event)
  const messageId = event.mail?.messageId ?? null

  if (toSuppress.length === 0) {
    // Deliveries, opens, transient bounces, rendering failures. Logged rather
    // than dropped: "did this address bounce softly?" is answerable from here.
    logger.info({
      ...ctx,
      eventType: event.eventType,
      bounceType: event.bounce?.bounceType,
      sesMessageId: messageId,
      destination: event.mail?.destination?.join(", "),
      message: "SES webhook: event recorded, no suppression",
    })
    return NextResponse.json({ ok: true })
  }

  for (const s of toSuppress) {
    const email = s.email.trim().toLowerCase()
    try {
      // Lowercased on the way in so the UNIQUE index gives idempotency under
      // SNS's at-least-once delivery — the same address in two casings would
      // otherwise be two rows, and only one would match at filter time.
      await execute(emailSuppressionsSql.upsert, [email, s.reason, s.detail, messageId])
      logger.warn({
        ...ctx, email, reason: s.reason, detail: s.detail, sesMessageId: messageId,
        message: "SES webhook: address suppressed",
      })
    } catch (e) {
      // Do not fail the whole delivery for one row — the remaining recipients
      // still deserve recording, and a 500 here would have SNS retry the batch.
      logger.error({
        ...ctx, email, error: e instanceof Error ? e.message : String(e),
        message: "SES webhook: suppression insert failed",
      })
    }
  }

  return NextResponse.json({ ok: true, suppressed: toSuppress.length })
}
