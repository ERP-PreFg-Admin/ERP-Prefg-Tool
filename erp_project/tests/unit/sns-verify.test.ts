// The SES webhook is the only unauthenticated write path in the app, so these two
// functions ARE its access control. A hole here lets anyone who learns the URL
// suppress a manufacturer's address — a denial of service on our own purchase
// orders — or turn the endpoint into an SSRF probe against instance metadata.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isAllowedSigningCertUrl,
  canonicalMessage,
  verifySnsSignature,
} from "../../lib/mail/sns-verify"

// ── SSRF guard ───────────────────────────────────────────────────────────────

test("accepts a genuine SNS signing cert URL", () => {
  assert.ok(isAllowedSigningCertUrl(
    "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc123.pem"
  ))
})

test("rejects a suffix-appended lookalike host", () => {
  // The attack the anchored regex exists for: without `$` this passes.
  assert.equal(isAllowedSigningCertUrl(
    "https://sns.ap-south-1.amazonaws.com.evil.example/x.pem"
  ), false)
})

test("rejects a prefix-prepended lookalike host", () => {
  assert.equal(isAllowedSigningCertUrl("https://evil.example/sns.ap-south-1.amazonaws.com/x.pem"), false)
})

test("rejects instance metadata — the SSRF target that matters on EC2", () => {
  assert.equal(isAllowedSigningCertUrl("http://169.254.169.254/latest/meta-data/"), false)
  assert.equal(isAllowedSigningCertUrl("https://169.254.169.254/latest/meta-data/"), false)
})

test("rejects http, even on a real SNS host", () => {
  // An interceptable cert fetch lets an on-path attacker substitute their own
  // signing key, which defeats the signature entirely.
  assert.equal(isAllowedSigningCertUrl(
    "http://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc.pem"
  ), false)
})

test("rejects other AWS services and garbage", () => {
  assert.equal(isAllowedSigningCertUrl("https://s3.ap-south-1.amazonaws.com/x.pem"), false)
  assert.equal(isAllowedSigningCertUrl("not a url"), false)
  assert.equal(isAllowedSigningCertUrl(""), false)
})

// ── Canonical form ───────────────────────────────────────────────────────────

test("Notification canonical form uses the documented field order", () => {
  const c = canonicalMessage({
    Type: "Notification", MessageId: "m1", TopicArn: "arn:t",
    Message: "body", Timestamp: "2026-01-01T00:00:00Z", Subject: "s",
  })
  assert.equal(c, "Message\nbody\nMessageId\nm1\nSubject\ns\nTimestamp\n2026-01-01T00:00:00Z\nTopicArn\narn:t\nType\nNotification\n")
})

test("an absent Subject is omitted, not included as empty", () => {
  // Including it as empty changes the signed bytes and fails every real message
  // that has no subject — which is most SES event notifications.
  const c = canonicalMessage({
    Type: "Notification", MessageId: "m1", TopicArn: "arn:t",
    Message: "body", Timestamp: "2026-01-01T00:00:00Z",
  })
  assert.equal(c, "Message\nbody\nMessageId\nm1\nTimestamp\n2026-01-01T00:00:00Z\nTopicArn\narn:t\nType\nNotification\n")
  assert.ok(!c!.includes("Subject"))
})

test("SubscriptionConfirmation uses its own field set, including Token", () => {
  const c = canonicalMessage({
    Type: "SubscriptionConfirmation", MessageId: "m1", TopicArn: "arn:t",
    Message: "body", Timestamp: "2026-01-01T00:00:00Z",
    Token: "tok", SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?x=1",
  })
  assert.ok(c!.includes("Token\ntok\n"))
  assert.ok(c!.includes("SubscribeURL\nhttps://sns.ap-south-1.amazonaws.com/?x=1\n"))
})

test("an unknown message Type produces no canonical form", () => {
  assert.equal(canonicalMessage({ Type: "SomethingNew" }), null)
})

// ── Signature verification, end to end ───────────────────────────────────────

const NEVER_CALLED = async (): Promise<string> => {
  throw new Error("fetchCert must not be called")
}

test("a bad cert host is refused BEFORE any fetch happens", async () => {
  // The ordering is the guard. If the fetch ran first, the SSRF would already
  // have occurred regardless of the verdict returned afterwards.
  const r = await verifySnsSignature(
    { Type: "Notification", Signature: "x", SigningCertURL: "http://169.254.169.254/" },
    NEVER_CALLED
  )
  assert.equal(r.ok, false)
})

test("a missing signature is refused without a fetch", async () => {
  const r = await verifySnsSignature(
    { Type: "Notification", SigningCertURL: "https://sns.ap-south-1.amazonaws.com/c.pem" },
    NEVER_CALLED
  )
  assert.equal(r.ok, false)
})

test("an unsupported SignatureVersion is refused", async () => {
  const r = await verifySnsSignature(
    {
      Type: "Notification", Signature: "x", SignatureVersion: "99",
      SigningCertURL: "https://sns.ap-south-1.amazonaws.com/c.pem",
    },
    NEVER_CALLED
  )
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /SignatureVersion/)
})

test("a real signature over the canonical form verifies, and a tampered body does not", async () => {
  const { generateKeyPairSync, createSign } = await import("node:crypto")
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()

  const msg: Record<string, unknown> = {
    Type: "Notification", MessageId: "m1", TopicArn: "arn:t",
    Message: '{"eventType":"Bounce"}', Timestamp: "2026-01-01T00:00:00Z",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.ap-south-1.amazonaws.com/c.pem",
  }
  const signer = createSign("RSA-SHA256")
  signer.update(canonicalMessage(msg)!, "utf8")
  msg.Signature = signer.sign(privateKey, "base64")

  assert.deepEqual(await verifySnsSignature(msg, async () => pem), { ok: true })

  // Same signature, altered payload — this is a forged suppression attempt.
  const tampered = { ...msg, Message: '{"eventType":"Complaint"}' }
  const bad = await verifySnsSignature(tampered, async () => pem)
  assert.equal(bad.ok, false)
})

test("a cert fetch failure is a rejection, never a pass", async () => {
  const r = await verifySnsSignature(
    {
      Type: "Notification", MessageId: "m", TopicArn: "a", Message: "b",
      Timestamp: "t", Signature: "x", SignatureVersion: "2",
      SigningCertURL: "https://sns.ap-south-1.amazonaws.com/c.pem",
    },
    async () => { throw new Error("network down") }
  )
  assert.equal(r.ok, false)
})
