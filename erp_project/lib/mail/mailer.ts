import nodemailer from "nodemailer"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import {
  GMAIL_USER, GMAIL_APP_PASSWORD,
  MAIL_PROVIDER, MAIL_FROM, MAIL_FROM_NAME, SES_CONFIG_SET,
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, APP_URL,
} from "@/lib/env"
import { query, execute } from "@/lib/db"
import { uploadFile, getFileBuffer } from "@/lib/s3"
import { s3FilesSql } from "@/lib/queries/s3-files"
import { generatePoPdf, type PoEmailData } from "@/lib/pdf/po-document"
import { generateSplitPoPdf } from "@/lib/pdf/split-po-document"
import { resolveLetterhead, resolveShipTo, type PoEmailRow } from "@/lib/pdf/po-letterhead"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { entityEmails } from "@/lib/queries/entity-emails"
import { emailSuppressionsSql } from "@/lib/queries/email-suppressions"
import { splitRecipients, type RecipientRow } from "@/lib/mail/recipients"
import { fetchPurchaseOrderPdf, UniwareSessionStale } from "@/lib/uniware"
import { buildMultiSheetXlsx, type ExportColumn } from "@/lib/export"
import { assertAttachmentsWithinLimit } from "@/lib/mail/mail-limits"
import { renderWelcomeMail } from "@/lib/mail/welcome-mail"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import crypto from "crypto"

// ── Transports ───────────────────────────────────────────────────────────────
//
// Nodemailer builds the MIME either way; only the delivery leg differs. That is
// why the migration touches the transport and the From header and nothing else —
// the templates, PO tables and multi-attachment assembly below are unchanged.
//
// SES: nodemailer 7's SES transport calls `new SendEmailCommand({ Content: {
// Raw: { Data } }, FromEmailAddress, Destination })` on the supplied client —
// the SESv2 shape, hence @aws-sdk/client-sesv2 rather than client-ses, and
// ses:SendEmail rather than the v1 ses:SendRawEmail in the IAM policy.
//
// Credentials are passed explicitly to mirror lib/s3.ts. When the EC2 instance
// role takes over (see instance-role-migration.md) both drop this block together
// and the SDK resolves via IMDS.
//
// Built lazily on first send, NOT at module load — same reason lib/s3.ts defers
// its client. The AWS SDK throws synchronously when `region` is empty, and this
// module is imported by routes that never send mail (e.g. preview-pdf, which
// only wants fetchPoData). At module scope that throw happened during Next's
// build-time page-data collection, where no AWS env vars are set:
//
//   Error: Region is missing
//   > Build error occurred
//   Failed to collect page data for /api/v1/purchase-orders/[id]/preview-pdf
//
// Deferring it means a missing mail env var breaks sending mail, not building
// the app or serving routes that merely import this file.
let _transporter: nodemailer.Transporter | undefined

function getTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter

  _transporter =
    MAIL_PROVIDER === "ses"
      ? nodemailer.createTransport({
          SES: {
            sesClient: new SESv2Client({
              region: AWS_REGION,
              credentials: {
                accessKeyId:     AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              },
            }),
            SendEmailCommand,
          },
        })
      : nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: GMAIL_USER,
            pass: GMAIL_APP_PASSWORD,
          },
          secure: true,
        })

  return _transporter
}

/** From header. Gmail can only send as the authenticated mailbox; SES sends as
 *  the address the IAM ses:FromAddress condition pins. */
const fromHeader =
  MAIL_PROVIDER === "ses"
    ? `${MAIL_FROM_NAME} <${MAIL_FROM}>`
    : `${MAIL_FROM_NAME} <${GMAIL_USER}>`

/** Extra SESv2 fields nodemailer merges into the command. Empty on Gmail, which
 *  would reject an unknown option. */
const sesOptions = MAIL_PROVIDER === "ses" ? { ses: { ConfigurationSetName: SES_CONFIG_SET } } : {}

/**
 * Per-send log context. This used to be a module-level constant, which meant one
 * requestId for the whole process lifetime — every mail line in CloudWatch shared
 * it, so correlating "which send produced this error" was impossible. One id per
 * send is the useful unit.
 */
function mailerCtx() {
  return { module: "MAILER", requestId: crypto.randomUUID() }
}

/** Which send path a line came from. A CloudWatch filter matches these exactly,
 *  so they are constants per call site, never built from data. */
export const MAIL_FLOW = {
  PO_SELECTION: "po_selection",
  PO_SPLIT: "po_split",
  INWARD_INVOICE: "inward_invoice",
  OPS_DIGEST: "ops_digest",
  LOW_OPEN_PO: "low_open_po",
  WELCOME: "welcome",
} as const

export type MailFlow = (typeof MAIL_FLOW)[keyof typeof MAIL_FLOW]

/** The countable fields on a send log line — without them the only signal is
 *  the message text, which no filter should key on. */
function mailOutcome(
  outcome: "sent" | "failed",
  flow: MailFlow,
  extra: { recipients: number; sesMessageId?: string }
) {
  return {
    mailOutcome: outcome,
    flow,
    recipients: extra.recipients,
    // Which transport sent it. Without this a historical line is unreadable
    // after a MAIL_PROVIDER switch — you cannot tell whether its id is an SES
    // one (joinable to the webhook) or a Gmail Message-ID (joinable to nothing).
    provider: MAIL_PROVIDER,
    messageId: extra.sesMessageId ?? null,
    // Only ever set on SES, so the webhook join cannot match a Gmail id.
    sesMessageId: MAIL_PROVIDER === "ses" ? extra.sesMessageId ?? null : null,
  }
}

// Attachment ceiling lives in lib/mail/mail-limits.ts so it can be unit-tested
// without importing this file's DB/PDF/Uniware dependencies.

/**
 * The PO document to attach — the stored one if this PO has ever been mailed,
 * otherwise rendered now and stored for next time.
 *
 * ── Why it is stored rather than re-rendered ────────────────────────────────
 * generatePoPdf reads the PO's CURRENT row. Re-rendering on a later send would
 * produce a document reflecting today's rate, quantity and destination, sent
 * under the same PO number the manufacturer already holds a different version
 * of. That is worse than sending nothing: it silently misrepresents an agreed
 * order, and afterwards nobody can say which version they were given.
 *
 * So the first send is the one that decides what the document says, and every
 * later send re-attaches those exact bytes.
 *
 * The key also lights up the row's "Review PDF" action, which is gated on
 * attachment_key being set — that option was missing for every mailed PO
 * precisely because nothing here ever wrote one.
 *
 * A read or upload failure is NOT fatal: the mail still goes with whatever else
 * it carries. Losing the attachment is bad; losing the notification is worse.
 */
async function poDocument(
  line: { id: number; po_no: string },
  render: (data: PoEmailData) => Promise<Buffer>,
  ctx: ReturnType<typeof mailerCtx>
): Promise<{ filename: string; content: Buffer } | null> {
  const filename = `PO-${line.po_no}.pdf`

  // Already stored? Send exactly what was sent before.
  const [existing] = await query<{ attachment_key: string | null }>(
    s3FilesSql.getPoAttachment,
    [line.id]
  )
  if (existing?.attachment_key) {
    try {
      const content = await getFileBuffer(existing.attachment_key)
      logger.info({ ...ctx, poId: line.id, po_no: line.po_no, key: existing.attachment_key, message: "PO document re-sent from S3" })
      return { filename, content }
    } catch (err) {
      // The row points at an object that isn't there. Fall through and render —
      // but do NOT overwrite the key, since something else owns it.
      logger.error({
        ...ctx, poId: line.id, po_no: line.po_no, key: existing.attachment_key,
        error: err instanceof Error ? err.message : String(err),
        message: "Stored PO document could not be read — rendering a fresh copy for this send only",
      })
    }
  }

  const data = await fetchPoData(line.id)
  if (!data) {
    // Used to be a silent `continue`. It is not the cause of any known bug, but
    // it is a second route to "no PDF and no explanation", which cost two wrong
    // hypotheses while diagnosing the first one.
    logger.warn({ ...ctx, poId: line.id, po_no: line.po_no, message: "No PO data for the document — selectForEmail returned nothing, attaching no PDF" })
    return null
  }

  const content = (await render(data)) as unknown as Buffer

  // Store for next time. Best-effort: a failed upload costs us the reuse, not
  // this send, so it must not throw past here.
  try {
    const stamp = new Date().toISOString().slice(0, 7)          // YYYY-MM
    const safe  = line.po_no.replace(/[^A-Za-z0-9_-]+/g, "_")
    const key   = `po-documents/${stamp}/${safe}-${line.id}.pdf`
    await uploadFile(content, key, "application/pdf")
    const res = await execute(s3FilesSql.setPoAttachmentIfAbsent, [key, line.id])
    logger.info({
      ...ctx, poId: line.id, po_no: line.po_no, key,
      claimed: res.affectedRows === 1,
      message: res.affectedRows === 1
        ? "PO document stored and linked to the PO"
        : "PO document stored, but the attachment slot was already taken — key not linked",
    })
  } catch (err) {
    logger.error({
      ...ctx, poId: line.id, po_no: line.po_no,
      error: err instanceof Error ? err.message : String(err),
      message: "PO document could not be stored — attached to this mail but not reusable",
    })
  }

  return { filename, content }
}

export async function fetchPoData(poId: number): Promise<PoEmailData | null> {
  const rows = await query<PoEmailRow>(purchaseOrdersSql.selectForEmail, [poId])
  const po = rows[0]
  if (!po) return null
  return {
    // Which legal entity is buying, and where the goods land. Resolved here so
    // both PO templates receive finished strings and can't disagree about it —
    // see lib/pdf/po-letterhead.ts for the fallback ladder.
    letterhead:      resolveLetterhead(po),
    ship_to:         resolveShipTo(po),
    po_no:           po.po_no,
    reference_po:    po.reference_po,
    po_type:         po.po_type ?? null,
    date:            po.date,
    expected_on:     po.expected_on,
    destination:     po.destination,
    dest_location:   po.dest_location  ?? null,
    sku_code:        po.sku_code,
    sku_name:        po.sku_name,
    qty:             Number(po.qty),
    unit_price:      po.unit_price    ? Number(po.unit_price)   : null,
    amount_pre_gst:  po.amount_pre_gst ? Number(po.amount_pre_gst) : null,
    total_amount:    po.total_amount  ? Number(po.total_amount) : null,
    mfg_name:        po.mfg_name,
    mfg_code:        po.mfg_code,
    registered_name: po.registered_name,
    gst_number:      po.gst_number,
    location:        po.location,
    mfg_email:       po.mfg_email,
    raised_by_name:  po.raised_by_name ?? "System",
  }
}

/**
 * All email addresses to notify for one entity: an optional primary contact
 * (details_mfg.email for a manufacturer; warehouses have none) plus every
 * address entered against it in the entity_emails contact list
 * (/po-tracking/po-procurement/entity-emails) — deduped case-insensitively.
 *
 * `entityCode` is whatever that list is keyed by: the mfg/vendor code, or a
 * warehouse's name, which is what purchase_orders.destination stores.
 */
export async function resolveRecipients(
  entityType: "mfg" | "vendor" | "warehouse" | "report",
  entityCode: string,
  primaryEmail: string | null = null,
  /**
   * Which legal entity's mail this is, for warehouses only — a site's point of
   * contact can differ for Pep vs Kreative. Recipients are then the shared
   * addresses PLUS that entity's, never the entity's alone.
   *
   * Omit it and only the shared addresses are used, which is the right fallback
   * when the entity can't be determined: a general warehouse inbox is a safer
   * place for a notification to land than nowhere.
   */
  legalEntityCode: string | null = null
): Promise<{ to: string[]; cc: string[]; dropped: string[] }> {
  // One query per shape, because each carries a different rule about which
  // employee rows come along: a site's, versus a manufacturer's plus the
  // "every manufacturer" wildcard.
  const rows =
    entityType === "warehouse"
      ? await query<RecipientRow>(entityEmails.selectByWarehouseForEntity, [entityCode, legalEntityCode])
      : entityType === "mfg"
      ? await query<RecipientRow>(entityEmails.selectForMfg, [entityCode, entityCode])
      : entityType === "report"
      ? await query<RecipientRow>(entityEmails.selectReportRecipients, [entityCode])
      : await query<RecipientRow>(entityEmails.selectByEntity, [entityType, entityCode])

  // Addresses SES has hard-bounced or that complained. Read per call rather than
  // cached: the list changes from the SNS webhook, and a stale cache here means
  // continuing to mail an address SES already rejected — which is the reputation
  // damage the suppression list exists to avoid.
  const suppressedRows = await query<{ email: string }>(emailSuppressionsSql.selectAll)
  const suppressed = new Set(suppressedRows.map((r) => r.email.toLowerCase()))

  const result = splitRecipients(rows, primaryEmail, suppressed)
  if (result.dropped.length > 0) {
    logger.warn({
      ...mailerCtx(), entityType, entityCode,
      dropped: result.dropped.join(", "),
      remaining: result.to.length + result.cc.length,
      message: "Recipients dropped — suppressed after an earlier bounce or complaint",
    })
  }
  return result
}

export type SelectedPoLine = {
  id: number
  po_no: string
  sku_code: string
  sku_name: string | null
  qty: number
  status: string
  /** Set when this PO is a split of another — the parent's po_no. */
  reference_po?: string | null
  destination?: string | null
  remarks?: string | null
  unit_price?: number | null
  /** Receipts so far, incl. a split's children. Cancelling cancels what has
   *  NOT arrived, so the Cancelled table quotes qty minus this. */
  received_qty?: number | null
  po_type?: string | null
}

// Same test PO Tracking badges with (PoDataRow); older rows predate po_type.
export const isImpromptuLine = (l: Pick<SelectedPoLine, "po_no" | "po_type">) =>
  l.po_type === "impromptu" || l.po_no.startsWith("IMP-")

type OngoingPoLine = {
  po_no: string; sku_code: string | null; sku_name: string | null; qty: number
  remarks?: string | null; unit_price?: number | null
}

// ATTACHABLE_STATUSES (raised | cancelled) used to gate whether a selected PO's
// document was attached. Removed: the route passes the EFFECTIVE status, so any
// PO with a part receipt read as 'partially_received' and lost its paperwork
// permanently — see poDocument(). The mail's sections are built by filtering
// `selected` directly (raisedLines / cancelledLines below), so nothing else
// needed the set.

// Null-tolerant on purpose. purchase_orders.sku_code is nullable, and one such
// row threw "Cannot read properties of null (reading 'replace')" out of the
// row map, losing the entire manufacturer's mail over one blank cell.
const escapeHtml = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

export type PoMailLine = {
  po_no: string; sku_code: string | null; sku_name: string | null; qty: number
  remarks?: string | null
  /** Excel only — the mail body stays compact. Null on POs raised before
   *  rates were resolved server-side (lib/po/po-rate.ts). */
  unit_price?: number | null
}

const CELL = "padding:5px 10px;border-bottom:1px solid #eee"

function poTableRows(lines: PoMailLine[], withRemarks: boolean): string {
  return lines
    .map(
      (l) => `
        <tr>
          <td style="${CELL}">${escapeHtml(l.po_no)}</td>
          <td style="${CELL}">${l.sku_code ? escapeHtml(l.sku_code) : "—"}</td>
          <td style="${CELL}">${l.sku_name ? escapeHtml(l.sku_name) : "—"}</td>
          <td style="${CELL};text-align:right">${Number(l.qty).toLocaleString("en-IN")}</td>
          ${withRemarks ? `<td style="${CELL};color:#555">${l.remarks ? escapeHtml(l.remarks) : "—"}</td>` : ""}
        </tr>`
    )
    .join("")
}

/**
 * Split the selection the way the two emails need it.
 *
 * A split is a re-issue of demand the manufacturer already holds, against an order
 * they can be pointed back at — so it gets its own mail (sendSplitPoSummaryEmail) rather
 * than a table inside the consolidated one, where "newly raised" would read as new
 * demand. Only raised splits: a cancelled one is a cancellation, and that belongs
 * in the consolidated mail's Cancelled table with the rest.
 *
 * Exported so tests/unit/split-po-email.test.ts can pin the partition without a
 * route, a transport or a database — same reason lib/po-split.ts was extracted.
 */
export function partitionSplits(lines: SelectedPoLine[]): {
  splits: SelectedPoLine[]
  rest: SelectedPoLine[]
} {
  const isSplit = (l: SelectedPoLine) => l.status === "raised" && !!l.reference_po
  return { splits: lines.filter(isSplit), rest: lines.filter((l) => !isSplit(l)) }
}

/**
 * `qtyLabel` is not decoration: the Cancelled table quotes what was cancelled
 * (ordered minus received), not the whole order, and a column still headed
 * "Quantity" would read to the manufacturer as the original order size.
 *
 * The Remarks column appears only when a line carries one, so the inward
 * invoice mail — which has no remarks — is unchanged.
 */
export function poSection(title: string, lines: PoMailLine[], qtyLabel = "Quantity"): string {
  if (lines.length === 0) return ""
  const withRemarks = lines.some((l) => !!l.remarks?.trim())
  const head = "padding:5px 10px;font-weight:600"
  return `
    <h3 style="margin:20px 0 4px;font-size:13px">${title}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="background:#f5f5f5">
        <td style="${head}">PO No.</td>
        <td style="${head}">SKU Code</td>
        <td style="${head}">SKU Name</td>
        <td style="${head};text-align:right">${escapeHtml(qtyLabel)}</td>
        ${withRemarks ? `<td style="${head}">Remarks</td>` : ""}
      </tr>
      ${poTableRows(lines, withRemarks)}
    </table>`
}

const PO_SHEET_COLUMNS: ExportColumn[] = [
  { key: "po_no", label: "PO No.", type: "text" },
  { key: "sku_code", label: "SKU Code", type: "text" },
  { key: "sku_name", label: "SKU Name", type: "text" },
  { key: "qty", label: "Quantity", type: "number" },
  { key: "unit_price", label: "Rate", type: "number" },
  { key: "remarks", label: "Remarks", type: "text" },
]

function toSheetRows(lines: PoMailLine[]): Record<string, unknown>[] {
  return lines.map((l) => ({
    ...l,
    remarks: l.remarks ?? "",
    // Blank, not 0 — an unpriced PO is unknown, and 0 reads as free.
    unit_price: l.unit_price == null ? "" : Number(l.unit_price),
  }))
}

/**
 * One consolidated email per manufacturer for a user-selected set of POs
 * (mix of any status — newly raised, cancelled, whatever the user picked in
 * the PO Procurement table's checkbox selection), with the PO PDF attached
 * for each raised/cancelled one, plus a live snapshot of every currently-open
 * PO for that manufacturer (including the ones just selected — they're
 * ongoing too, shown as-is).
 *
 * Returns true if sent, false if the manufacturer has no email on file.
 * Throws on actual send failures — caller decides whether that fails the
 * whole multi-manufacturer send or just that manufacturer's leg.
 */
export async function sendMfgSelectionEmail(
  mfgId: number,
  selected: SelectedPoLine[]
): Promise<boolean> {
  const ctx = mailerCtx()
  const mfgRows = await query<{ code: string; name: string; email: string | null }>(
    `SELECT m.code, m.name, d.email FROM master_mfgs m JOIN details_mfg d ON d.mfg_id = m.id WHERE m.id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, message: "sendMfgSelectionEmail: manufacturer not found" })
    return false
  }

  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const formatted = `${year}-${month}-${day}`;
  

  const { to, cc, dropped } = await resolveRecipients("mfg", mfg.code, mfg.email)
  // Both empty, not just `to`: an internal employee copied on every
  // manufacturer is a real recipient, so a mail with only a CC still goes.
  if (to.length === 0 && cc.length === 0) {
    // "No email on file" and "every address was suppressed" need different
    // fixes — add a contact, versus correct a bounced one — so the log has to
    // say which. Reporting the wrong one sends someone hunting the wrong screen.
    logger.warn({
      ...ctx, mfgId,
      suppressed: dropped.length > 0 ? dropped.join(", ") : undefined,
      message: dropped.length > 0
        ? "sendMfgSelectionEmail: every recipient is suppressed after an earlier bounce or complaint, skipping"
        : "sendMfgSelectionEmail: manufacturer has no email on file, skipping",
    })
    return false
  }

  const ongoing = await query<{ id: number; po_no: string; sku_code: string; sku_name: string | null; qty: number; remarks: string | null; unit_price: number | null; expected_on: string | null; status: string }>(purchaseOrdersSql.ongoingByMfg, [mfgId])
  const openLines: OngoingPoLine[] = ongoing.map((r) => ({
    po_no: r.po_no, sku_code: r.sku_code, sku_name: r.sku_name, qty: Number(r.qty),
    remarks: r.remarks, unit_price: r.unit_price,
  }))

  // Selected lines split into the tables the summary shows — any other selected
  // status (e.g. punched, received) isn't part of this summary.
  //
  // No split filter here: the route partitions them off with partitionSplits()
  // before calling, so a raised split never reaches this function. Re-filtering
  // would be a guard against a caller that doesn't exist, and it would hide the
  // real bug (a split routed to the wrong mail) by silently dropping the line.
  const raisedLines    = selected.filter((l) => l.status === "raised")
  // Cancelling a PO cancels the part that never arrived, so the table quotes
  // ordered minus received. Clamped: an over-receipt would otherwise go negative.
  const cancelledLines = selected
    .filter((l) => l.status === "cancelled")
    .map((l) => ({ ...l, qty: Math.max(Number(l.qty) - Number(l.received_qty ?? 0), 0) }))

  // An all-impromptu send keeps the open book in the Excel only, not the body.
  const allImpromptu = selected.every(isImpromptuLine)

  const attachments: { filename: string; content: Buffer }[] = []
  let pdfsAttached = 0
  // Every selected PO gets its document, whatever its status. The old
  // ATTACHABLE_STATUSES gate here meant that receiving even one unit against a
  // raised PO turned its effective status to 'partially_received' and the
  // manufacturer could never be sent that order's paperwork again — on a 10,000
  // unit PO with 1,200 in, which is exactly when they still need it.
  //
  //
  // Bounded by the operator's selection: the "Current Open" section comes from
  // ongoingByMfg and never contributes attachments, so this cannot balloon with
  // the manufacturer's open book. assertAttachmentsWithinLimit below is the
  // backstop for a very large selection.
  for (const line of selected) {
    // PDF ONLY. A cancelled PO still appears in the Cancelled table and on the
    // Excel sheet — this withholds just its document, which is an order to
    // supply and has no business riding along with the mail that withdraws it.
    // Skips 'cancelled' alone: the old ATTACHABLE_STATUSES whitelist is not
    // coming back, or a part-received PO loses its copy again.
    if (line.status === "cancelled") continue
    try {
      const doc = await poDocument(line, generatePoPdf, ctx)
      if (!doc) continue
      attachments.push(doc)
      pdfsAttached++
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, poId: line.id, po_no: line.po_no, error: message, message: "PO PDF generation failed for selection email — sending without this attachment" })
    }
  }

  // No Splits sheet: a raised split isn't in this mail at all any more. It still
  // appears under Open when it is genuinely still awaiting goods, which is what
  // ongoingByMfg returns — that is deliberate and must not be filtered.
  const xlsxBuffer = await buildMultiSheetXlsx([
    { name: "Raised",    columns: PO_SHEET_COLUMNS, rows: toSheetRows(raisedLines) },
    { name: "Cancelled", columns: PO_SHEET_COLUMNS, rows: toSheetRows(cancelledLines) },
    { name: "Open",      columns: PO_SHEET_COLUMNS, rows: toSheetRows(openLines) },
  ])
  attachments.push({ filename: `PO-Summary-${mfg.code}.xlsx`, content: Buffer.from(xlsxBuffer) })

  assertAttachmentsWithinLimit(attachments, `PO selection email for ${mfg.code}`)

  // Everyone the mail reached, for the audit trail — the split is a header
  // detail, and a log that lists only To answers "who was told?" wrongly.
  const allRecipients = [...to, ...cc].join(", ")

  const eventId = makeEventId("PO_SELECTION_EMAIL", "send", mfgId)
  recordRawEvent("PO_SELECTION_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, mfg_email: allRecipients, selectedCount: selected.length, attachmentCount: attachments.length,
  })

  let sesMessageId: string | undefined
  try {
    const info = await getTransporter().sendMail({
      ...sesOptions,
      from: fromHeader,
      to: to.join(", "),
      // Omitted entirely when empty rather than sent as "": nodemailer treats a
      // blank Cc as a malformed address and throws.
      ...(cc.length ? { cc: cc.join(", ") } : {}),
      subject: `PO Update — ${mfg.name} - ${formatted}`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:auto;color:#111">
          <h2 style="margin-bottom:4px">PO Update: ${mfg.name}</h2>
          <p style="color:#555;margin-top:0">Please find the latest status of the following purchase orders${pdfsAttached > 0 ? " (PO copies attached; full details in the attached Excel)" : " (full details in the attached Excel)"}.</p>
          ${poSection("Newly Raised Purchase Orders", raisedLines)}
          ${poSection("Cancelled Purchase Orders", cancelledLines, "Cancelled Qty")}
          ${allImpromptu ? "" : poSection("Current Open Purchase Orders", openLines)}
          <p style="font-size:12px;color:#888;margin-top:20px">
            This is an auto-generated email from the mcaffeine ERP system.
            Please confirm receipt by replying to this email.
          </p>
        </div>
      `,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    sesMessageId = info?.messageId
  } catch (sendErr: unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    const stack = sendErr instanceof Error ? sendErr.stack : undefined
    logger.error({ ...ctx, ...mailOutcome("failed", MAIL_FLOW.PO_SELECTION, { recipients: to.length + cc.length }), eventId, err: message, stack, message: "PO selection email send failed" })
    recordFailedEvent("PO_SELECTION_EMAIL", eventId, { mfgId, mfg_name: mfg.name }, message)
    throw sendErr
  }

  logger.info({ ...ctx, ...mailOutcome("sent", MAIL_FLOW.PO_SELECTION, { recipients: to.length + cc.length, sesMessageId }), eventId, mfgId, mfg_name: mfg.name, mfg_email: allRecipients, message: "PO selection email sent successfully" })
  recordProcessedEvent("PO_SELECTION_EMAIL", eventId, { mfgId, mfg_name: mfg.name, mfg_email: allRecipients })
  return true
}

// ── Split PO notification ────────────────────────────────────────────────────

export type SplitSummaryRow = {
  po_no: string; sku_code: string | null; sku_name: string | null
  qty: number; ship_to_name: string | null; ship_to_lines: string[]
}

/** The split summary table, ending in a Total row over Split Qty. */
export function splitSummarySection(rows: SplitSummaryRow[]): string {
  if (rows.length === 0) return ""
  const head = "padding:5px 10px;font-weight:600"
  const total = rows.reduce((s, r) => s + Number(r.qty), 0)
  const body = rows
    .map((r) => {
      // Deduped: the no-entity fallback is warehouse name + location, often the same word.
      const dest = [...new Set([r.ship_to_name, ...r.ship_to_lines].filter(Boolean))]
        .map((l) => escapeHtml(l)).join("<br>")
      return `
        <tr>
          <td style="${CELL}">${r.sku_code ? escapeHtml(r.sku_code) : "—"}</td>
          <td style="${CELL}">${r.sku_name ? escapeHtml(r.sku_name) : "—"}</td>
          <td style="${CELL};font-size:11px;color:#333">${dest || "—"}</td>
          <td style="${CELL}">${escapeHtml(r.po_no)}</td>
          <td style="${CELL};text-align:right">${Number(r.qty).toLocaleString("en-IN")}</td>
        </tr>`
    })
    .join("")
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:12px">
      <tr style="background:#f5f5f5">
        <td style="${head}">SKU Code</td>
        <td style="${head}">SKU Name</td>
        <td style="${head}">Destination</td>
        <td style="${head}">New PO Code</td>
        <td style="${head};text-align:right">Split Qty</td>
      </tr>
      ${body}
      <tr style="background:#f5f5f5">
        <td style="${head}" colspan="4">Total</td>
        <td style="${head};text-align:right">${total.toLocaleString("en-IN")}</td>
      </tr>
    </table>`
}

/**
 * One email per manufacturer covering every split in the send: a summary table
 * plus each split's PO document. No open snapshot, no XLSX.
 * Returns false if there is nobody to send to; throws on a real send failure.
 */
export async function sendSplitPoSummaryEmail(mfgId: number, lines: SelectedPoLine[]): Promise<boolean> {
  const ctx = mailerCtx()
  const mfgRows = await query<{ code: string; name: string; email: string | null }>(
    `SELECT m.code, m.name, d.email FROM master_mfgs m JOIN details_mfg d ON d.mfg_id = m.id WHERE m.id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  const poNos = lines.map((l) => l.po_no)
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, poNos, message: "sendSplitPoSummaryEmail: manufacturer not found" })
    return false
  }

  const { to, cc, dropped } = await resolveRecipients("mfg", mfg.code, mfg.email)
  // Both empty, not just `to` — an internal employee copied on every manufacturer
  // is a real recipient, so a mail with only a CC still goes.
  if (to.length === 0 && cc.length === 0) {
    logger.warn({
      ...ctx, mfgId, poNos,
      suppressed: dropped.length > 0 ? dropped.join(", ") : undefined,
      message: dropped.length > 0
        ? "sendSplitPoSummaryEmail: every recipient is suppressed after an earlier bounce or complaint, skipping"
        : "sendSplitPoSummaryEmail: manufacturer has no email on file, skipping",
    })
    return false
  }

  // Address from the same resolver the split PDF prints, so the two can't disagree.
  // A PDF failure doesn't stop the mail — the table carries the same details.
  const rows: SplitSummaryRow[] = []
  const attachments: { filename: string; content: Buffer }[] = []
  for (const line of lines) {
    const data = await fetchPoData(line.id).catch(() => null)
    rows.push({
      po_no: line.po_no, sku_code: line.sku_code, sku_name: line.sku_name, qty: Number(line.qty),
      ship_to_name: data?.ship_to.name ?? line.destination ?? null,
      ship_to_lines: data?.ship_to.address_lines ?? [],
    })
    try {
      const doc = await poDocument(line, generateSplitPoPdf, ctx)
      if (doc) attachments.push(doc)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({
        ...ctx, poId: line.id, po_no: line.po_no, error: message,
        message: "Split PO PDF generation failed — sending the summary without this attachment",
      })
    }
  }

  assertAttachmentsWithinLimit(attachments, `Split PO summary email for ${mfg.code}`)

  const date = new Date()
  const formatted = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  const allRecipients = [...to, ...cc].join(", ")
  const eventId = makeEventId("PO_SPLIT_EMAIL", "send", mfgId)
  recordRawEvent("PO_SPLIT_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, mfg_email: allRecipients, poNos, attachmentCount: attachments.length,
  })

  let sesMessageId: string | undefined
  try {
    const info = await getTransporter().sendMail({
      ...sesOptions,
      from: fromHeader,
      to: to.join(", "),
      // Omitted when empty rather than sent as "": nodemailer treats a blank Cc as
      // a malformed address and throws.
      ...(cc.length ? { cc: cc.join(", ") } : {}),
      // Parent POs stay out of the subject — they're named per row in the body.
      subject: `Split POs — ${mfg.name} - ${formatted}`,
      html: `
        <div style="font-family:sans-serif;max-width:720px;margin:auto;color:#111">
          <h2 style="margin-bottom:4px">Split Purchase Orders: ${escapeHtml(mfg.name)}</h2>
          <p style="color:#555;margin-top:0">
            These are parts of existing purchase orders re-issued as their own POs — not additional quantity${attachments.length > 0 ? ". The PO documents are attached" : ""}.
          </p>
          ${splitSummarySection(rows)}
          <p style="font-size:12px;color:#888;margin-top:20px">
            This is an auto-generated email from the mcaffeine ERP system.
            Please confirm receipt by replying to this email.
          </p>
        </div>
      `,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    sesMessageId = info?.messageId
  } catch (sendErr: unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    const stack = sendErr instanceof Error ? sendErr.stack : undefined
    logger.error({ ...ctx, ...mailOutcome("failed", MAIL_FLOW.PO_SPLIT, { recipients: to.length + cc.length }), eventId, poNos, err: message, stack, message: "Split PO summary email send failed" })
    recordFailedEvent("PO_SPLIT_EMAIL", eventId, { mfgId, mfg_name: mfg.name, poNos }, message)
    throw sendErr
  }

  logger.info({
    ...ctx, ...mailOutcome("sent", MAIL_FLOW.PO_SPLIT, { recipients: to.length + cc.length, sesMessageId }),
    eventId, mfgId, mfg_name: mfg.name, mfg_email: allRecipients, poNos,
    message: "Split PO summary email sent successfully",
  })
  recordProcessedEvent("PO_SPLIT_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, mfg_email: allRecipients, poNos,
  })
  return true
}

// ── Inward invoice notification ──────────────────────────────────────────────
// Sent when an invoice is turned into inward POs. Deliberately not
// sendMfgSelectionEmail: that one reports PO status to the manufacturer and
// attaches PO documents we generate. This one goes to the receiving warehouse
// instead — the manufacturer already knows the order and shipped the goods; it
// is the warehouse that needs the paperwork for stock arriving at their door.
// So the invoice we read is the attachment, the SKU summary says what to
// expect, and the mail is a covering note rather than a report.

/** "2-AUG-26" — the format the MIS team uses in these subjects. */
function subjectDate(value: string | null): string {
  if (!value) return ""
  // YYYY-MM-DD is parsed by hand: new Date() treats it as UTC midnight, which
  // shifts the day backwards for anyone reading west of the meridian.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const d = ymd
    ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const mon = d.toLocaleString("en-US", { month: "short" }).toUpperCase()
  return `${d.getDate()}-${mon}-${String(d.getFullYear()).slice(-2)}`
}

export type InwardInvoiceMail = {
  /** Whose goods these are — named in the subject, not mailed. */
  mfgId: number
  /**
   * The receiving warehouse: purchase_orders.destination, which stores a
   * master_warehouse.name. Recipients are the entity_emails rows filed under
   * entity_type 'warehouse' with this exact name as the code.
   */
  destination: string
  facility: string | undefined
  /**
   * The legal entity billed on this invoice (master_entity.code), resolved from
   * buyer_gstin in lib/invoice/invoice-inward.ts. Selects that entity's point of contact
   * at the warehouse on top of the shared addresses. Undefined only when Uniware
   * is unconfigured, in which case the shared addresses alone are used.
   */
  legalEntityCode: string | undefined
  invoiceNo: string
  /** Invoice date as entered on the review form (YYYY-MM-DD). */
  invoiceDate: string | null
  /** The PO code we registered in Uniware — quoted in the body as the reference. */
  uniwarePoCode: string | null
  /** The original invoice, attached as-is. */
  invoicePdf: { filename: string; content: Buffer } | null
  /** The inward POs this invoice created — summarised in the body so the
   *  warehouse can check what to expect without opening the PDF. */
  items: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]
}

/**
 * Notify the receiving warehouse that an invoice has been inwarded.
 *
 * Returns false (rather than throwing) when there's no one to send to — a
 * warehouse with no email on file is a data gap, not a failure of the invoice,
 * which is already committed by the time this runs.
 */
export type InwardMailOutcome = {
  /** False when there was nobody to send to — a data gap, not a failure. */
  sent: boolean
  /**
   * Set when the mail went out but WITHOUT the Uniware PO document.
   *
   * Used to be the normal case for 17 of 18 facilities — /po/show serves only the
   * session's own facility and the session sat on GGN_WAREHOUSE. It is switched
   * per fetch now, so this means a dead session or a real Uniware failure.
   */
  missingPoDocument?: string
}

export async function sendInwardInvoiceEmail(mail: InwardInvoiceMail): Promise<InwardMailOutcome> {
  const ctx = mailerCtx()
  const { mfgId, destination, facility, legalEntityCode, invoiceNo, invoiceDate, uniwarePoCode, invoicePdf, items } = mail

  // Only for the subject line — the manufacturer is not a recipient here.
  const mfgRows = await query<{ code: string; name: string }>(
    `SELECT code, name FROM master_mfgs WHERE id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, message: "sendInwardInvoiceEmail: manufacturer not found" })
    return { sent: false }
  }

  // Shared warehouse addresses plus this legal entity's own point of contact.
  const { to, cc, dropped } = await resolveRecipients("warehouse", destination, null, legalEntityCode ?? null)
  // Both empty, not just `to`: an employee attached to this site is a real
  // recipient, so a CC-only notification still goes out.
  if (to.length === 0 && cc.length === 0) {
    logger.warn({
      ...ctx, mfgId, destination, legalEntityCode,
      suppressed: dropped.length > 0 ? dropped.join(", ") : undefined,
      message: dropped.length > 0
        ? "sendInwardInvoiceEmail: every recipient is suppressed after an earlier bounce or complaint, skipping"
        : "sendInwardInvoiceEmail: warehouse has no email on file, skipping",
    })
    return { sent: false }
  }

  // Subject format left as the MIS team wrote it, even though the audience
  // moved — the destination is on the body's summary table instead.
  const dated = subjectDate(invoiceDate)
  const subject =
    `Create PO : ${mfg.name.toUpperCase()} || Invoice No : ${invoiceNo}` + (dated ? ` || ${dated}` : "")

  const attachments: { filename: string; content: Buffer }[] = []
  if (invoicePdf) attachments.push(invoicePdf)

  // The Uniware PO document alongside the invoice, so the warehouse has both
  // halves of the paperwork. Best-effort: the goods are already booked and the
  // invoice is the attachment that matters, so a Uniware hiccup downgrades the
  // mail rather than blocking it — but the caller is TOLD it was downgraded.
  let missingPoDocument: string | undefined
  if (uniwarePoCode) {
    try {
      const poPdf = await fetchPurchaseOrderPdf(uniwarePoCode ,facility)
      // Codes carry slashes (GM/2627/PO/2006) — not a filename.
      const safeCode = uniwarePoCode.replace(/[^a-zA-Z0-9._-]/g, "-")
      attachments.push({ filename: `Uniware-PO-${safeCode}.pdf`, content: poPdf })
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      // The session, not the PO, is what usually fails now — and an expired one
      // is the only cause a human can fix, so lead with it.
      const stale = err instanceof UniwareSessionStale
      missingPoDocument =
        (stale ? "The Uniware session has expired — renew it with the extension, then use Sync Documents. " : "") +
        `Uniware would not produce the PO document for ${uniwarePoCode}` +
        `${facility ? ` at ${facility}` : ""} — ${reason}`
      logger.error({
        ...ctx, mfgId, destination, invoiceNo, uniwarePoCode, facility, stale, err: reason,
        message: "Uniware PO document could not be downloaded — sending without it",
      })
    }
  }

  assertAttachmentsWithinLimit(attachments, `Inward invoice email for ${invoiceNo}`)

  // Everyone the mail reached, for the audit trail — To and CC together.
  const allRecipients = [...to, ...cc].join(", ")

  const eventId = makeEventId("PO_INWARD_INVOICE_EMAIL", "send", mfgId)
  recordRawEvent("PO_INWARD_INVOICE_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, destination, invoiceNo, uniwarePoCode,
    warehouse_email: allRecipients, attachmentCount: attachments.length,
  })

  let sesMessageId: string | undefined
  try {
    const info = await getTransporter().sendMail({
      ...sesOptions,
      from: fromHeader,
      to: to.join(", "),
      // Omitted entirely when empty — nodemailer throws on a blank Cc.
      ...(cc.length ? { cc: cc.join(", ") } : {}),
      subject,
      // Signed by the SYSTEM, not by whoever filed the invoice. The warehouse is
      // being told what arrived, and replies belong to the inbox this was sent
      // from — a personal name and job title invited replies to someone who may
      // not own the invoice any more, and read as a person vouching for an
      // automated summary. MAIL_FROM_NAME is the same name the From header
      // already carries, so the signature and the sender agree.
      //
      // Note this is a TEMPLATE LITERAL, not JSX: a `{/* … */}` here would be
      // sent to the warehouse as body text.
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:auto;color:#111;font-size:14px;line-height:1.6">
          <p style="margin:0">PFA</p>
          <p style="margin:12px 0 0;font-weight:600">
            ${uniwarePoCode ? `${escapeHtml(uniwarePoCode)}<br>` : ""}Invoice No: ${escapeHtml(invoiceNo)}
          </p>
          ${poSection(`Items Inwarded at ${escapeHtml(destination)}`, items)}
          <p style="margin:20px 0 0">Thanks &amp; Regards<br>${escapeHtml(MAIL_FROM_NAME)}</p>
        </div>
      `,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
    sesMessageId = info?.messageId
  } catch (sendErr: unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    logger.error({ ...ctx, ...mailOutcome("failed", MAIL_FLOW.INWARD_INVOICE, { recipients: to.length + cc.length }), eventId, mfgId, destination, invoiceNo, err: message, message: "Inward invoice email send failed" })
    recordFailedEvent("PO_INWARD_INVOICE_EMAIL", eventId, { mfgId, destination, invoiceNo }, message)
    throw sendErr
  }

  logger.info({
    ...ctx, ...mailOutcome("sent", MAIL_FLOW.INWARD_INVOICE, { recipients: to.length + cc.length, sesMessageId }),
    eventId, mfgId, mfg_name: mfg.name, destination, invoiceNo, uniwarePoCode,
    warehouse_email: allRecipients, attachmentCount: attachments.length,
    poDocumentAttached: uniwarePoCode ? !missingPoDocument : undefined,
    message: "Inward invoice email sent to warehouse",
  })
  recordProcessedEvent("PO_INWARD_INVOICE_EMAIL", eventId, {
    mfgId, destination, invoiceNo, uniwarePoCode, missingPoDocument,
  })
  return { sent: true, missingPoDocument }
}

export const OPS_DIGEST_CODE = "daily_ops"
export const LOW_OPEN_PO_CODE = "po_low_open_qty"

async function sendReportEmail(
  reportCode:string , subject:string , html:string , flow:MailFlow , day:string
): Promise<boolean> {
  const ctx = mailerCtx()
  const { to , cc } = await resolveRecipients("report" , reportCode)
  
  if(to.length === 0 && cc.length === 0) {
    logger.warn({...ctx , flow , reportCode , day , message : "Report has no active recipients - not sent"})
    return false
  }

  const primary = to.length > 0 ? to : cc
  const secondary = to.length > 0 ? cc : []

  const recipients = primary.length + secondary.length

  let sesMessageId: string | undefined
  try {
    const info = await getTransporter().sendMail({
      ... sesOptions , 
      from : fromHeader , 
      to: primary.join(", "),
      ... (secondary.length ? {cc : secondary.join(", ")} : {}),
      subject , 
      html
    })
    sesMessageId = info?.messageId
  } catch(sendErr : unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    logger.error({...ctx , ... mailOutcome("failed" , flow , {recipients , sesMessageId}) , reportCode , day , error: message ,  message:"Report Email send failed."})
    throw sendErr
  }

  logger.info({ ...ctx, ...mailOutcome("sent", flow, { recipients, sesMessageId }), reportCode, day, message: "Report email sent successfully" })
  return true
}

export const sendOpsDigestEmail = (day: string, html: string) =>
  sendReportEmail(OPS_DIGEST_CODE, `ERP daily report — ${day}`, html, MAIL_FLOW.OPS_DIGEST, day)

export const sendLowOpenPoEmail = (day: string, html: string) =>
  sendReportEmail(LOW_OPEN_PO_CODE, `Low open PO quantity — ${day}`, html, MAIL_FLOW.LOW_OPEN_PO, day)

export type WelcomeOutcome = { sent: boolean; reason?: string }

// To the new user, CC the admin who added them. Never throws — a failed welcome must not fail the create.
export async function sendWelcomeEmail(o: {
  user: { name: string; email: string }
  admin: { name: string; email: string }
}): Promise<WelcomeOutcome> {
  const ctx = mailerCtx()
  try {
    // AUTH_URL is the site's own address at runtime; NEXT_PUBLIC_APP_URL is baked in at build.
    const appUrl = process.env.AUTH_URL || APP_URL
    const suppressedRows = await query<{ email: string }>(emailSuppressionsSql.selectAll)
    const suppressed = new Set(suppressedRows.map((r) => r.email.toLowerCase()))
    const { to, cc, dropped } = splitRecipients([{ email: o.admin.email, recipient_type: "cc" }], o.user.email, suppressed)
    if (to.length === 0) {
      logger.warn({ ...ctx, email: o.user.email, dropped: dropped.join(", "), message: "Welcome mail not sent — the address is suppressed after an earlier bounce or complaint" })
      return { sent: false, reason: "suppressed" }
    }
    const m = renderWelcomeMail({ name: o.user.name, email: o.user.email, appUrl, admin: o.admin })
    const info = await getTransporter().sendMail({
      ...sesOptions,
      from: fromHeader,
      to: to.join(", "),
      ...(cc.length ? { cc: cc.join(", ") } : {}),
      subject: m.subject,
      html: m.html,
      text: m.text,
    })
    logger.info({ ...ctx, ...mailOutcome("sent", MAIL_FLOW.WELCOME, { recipients: to.length + cc.length, sesMessageId: info?.messageId }), email: o.user.email, message: "Welcome mail sent" })
    return { sent: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ ...ctx, ...mailOutcome("failed", MAIL_FLOW.WELCOME, { recipients: 1 }), email: o.user.email, error: message, message: "Welcome mail failed" })
    return { sent: false, reason: message }
  }
}
