// Attachment size ceiling for outbound mail.
//
// Split out of lib/mailer.ts so it is unit-testable: importing the mailer pulls
// in lib/db (which opens a pool at module load), lib/pdf and lib/uniware, none of
// which belong in a pure test. Same reasoning as lib/po-split.ts vs
// lib/po-receive.ts.

/**
 * SESv2 caps a raw message at 40 MB. Nodemailer base64-encodes attachments into
 * the MIME body, which inflates them by roughly 33%, so the usable raw budget is
 * about 28 MB (28 × 1.37 ≈ 38.4 MB, leaving headroom for headers and the HTML
 * part).
 *
 * Gmail's own limit is 25 MB, lower than this — but the ceiling is deliberately
 * set for SES, the transport being migrated to. Anything that fits SES and not
 * Gmail fails only while MAIL_PROVIDER=gmail, which is the temporary state.
 */
export const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024

const mb = (n: number) => (n / 1024 / 1024).toFixed(1)

/**
 * Throws when the attachments would exceed what SES accepts.
 *
 * sendMfgSelectionEmail attaches one PDF per raised/cancelled PO plus an XLSX
 * summary, so total size grows with the operator's selection and is otherwise
 * unbounded. Failing here names the cause and the count; letting it reach SES
 * produces an opaque size rejection with nothing actionable in it.
 */
export function assertAttachmentsWithinLimit(
  attachments: readonly { filename: string; content: Buffer }[],
  what: string
): void {
  const total = attachments.reduce((n, a) => n + a.content.length, 0)
  if (total <= MAX_ATTACHMENT_BYTES) return
  throw new Error(
    `${what}: ${attachments.length} attachments total ${mb(total)} MB, over the ` +
    `${mb(MAX_ATTACHMENT_BYTES)} MB limit. Send in smaller batches.`
  )
}
