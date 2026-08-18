import nodemailer from "nodemailer"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import {
  GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_SIGNATURE_TITLE,
  MAIL_PROVIDER, MAIL_FROM, MAIL_FROM_NAME, SES_CONFIG_SET,
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
} from "@/lib/env"
import { query } from "@/lib/db"
import { generatePoPdf, type PoEmailData } from "@/lib/pdf/po-document"
import { resolveLetterhead, resolveShipTo, type PoEmailRow } from "@/lib/pdf/po-letterhead"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { entityEmails } from "@/lib/queries/entity-emails"
import { splitRecipients, type RecipientRow } from "@/lib/recipients"
import { fetchPurchaseOrderPdf } from "@/lib/uniware"
import { buildMultiSheetXlsx, type ExportColumn } from "@/lib/export"
import { assertAttachmentsWithinLimit } from "@/lib/mail-limits"
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
const sesTransport = nodemailer.createTransport({
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

const gmailTransport = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
  secure: true,
})

const transporter = MAIL_PROVIDER === "ses" ? sesTransport : gmailTransport

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

// Attachment ceiling lives in lib/mail-limits.ts so it can be unit-tested
// without importing this file's DB/PDF/Uniware dependencies.

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
    date:            po.date,
    expected_on:     po.expected_on,
    destination:     po.destination,
    dest_location:   po.dest_location  ?? null,
    sku_code:        po.sku_code,
    sku_name:        po.sku_name,
    qty:             Number(po.qty),
    unit_price:      po.unit_price    ? Number(po.unit_price)   : null,
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
  entityType: "mfg" | "vendor" | "warehouse",
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
): Promise<{ to: string[]; cc: string[] }> {
  // One query per shape, because each carries a different rule about which
  // employee rows come along: a site's, versus a manufacturer's plus the
  // "every manufacturer" wildcard.
  const rows =
    entityType === "warehouse"
      ? await query<RecipientRow>(entityEmails.selectByWarehouseForEntity, [entityCode, legalEntityCode])
      : entityType === "mfg"
      ? await query<RecipientRow>(entityEmails.selectForMfg, [entityCode, entityCode])
      : await query<RecipientRow>(entityEmails.selectByEntity, [entityType, entityCode])
  return splitRecipients(rows, primaryEmail)
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
}
type OngoingPoLine = { po_no: string; sku_code: string; sku_name: string | null; qty: number }

// Statuses worth attaching a PDF copy for — the two actions this flow exists
// to notify manufacturers about. Other selected statuses (received, punched,
// etc.) just show up in the summary table with no attachment.
const ATTACHABLE_STATUSES = new Set(["raised", "cancelled"])

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

function poTableRows(lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): string {
  return lines
    .map(
      (l) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.po_no)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.sku_code)}${l.sku_name ? " — " + escapeHtml(l.sku_name) : ""}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">${Number(l.qty).toLocaleString("en-IN")}</td>
        </tr>`
    )
    .join("")
}

/**
 * The split-PO table. A split needs two columns the others don't — the order it
 * came off, so the manufacturer can reconcile it against paperwork they already
 * hold, and the destination, since splitting a PO is usually about sending part
 * of it somewhere else.
 */
function splitSection(lines: SelectedPoLine[]): string {
  if (lines.length === 0) return ""
  return `
    <h3 style="margin:20px 0 4px;font-size:14px">Split Purchase Orders</h3>
    <p style="margin:0 0 6px;font-size:12px;color:#555">
      Part of an existing order, re-issued as its own PO. The original PO number is shown against each line.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5">
        <td style="padding:6px 12px;font-weight:600">PO No.</td>
        <td style="padding:6px 12px;font-weight:600">Split From</td>
        <td style="padding:6px 12px;font-weight:600">SKU</td>
        <td style="padding:6px 12px;font-weight:600">Deliver To</td>
        <td style="padding:6px 12px;font-weight:600;text-align:right">Quantity</td>
      </tr>
      ${lines.map((l) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.po_no)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.reference_po ?? "—")}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.sku_code)}${l.sku_name ? " — " + escapeHtml(l.sku_name) : ""}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${escapeHtml(l.destination ?? "—")}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">${Number(l.qty).toLocaleString("en-IN")}</td>
        </tr>`).join("")}
    </table>`
}

export function poSection(title: string, lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): string {
  if (lines.length === 0) return ""
  return `
    <h3 style="margin:20px 0 4px;font-size:14px">${title}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5">
        <td style="padding:6px 12px;font-weight:600">PO No.</td>
        <td style="padding:6px 12px;font-weight:600">SKU</td>
        <td style="padding:6px 12px;font-weight:600;text-align:right">Quantity</td>
      </tr>
      ${poTableRows(lines)}
    </table>`
}

const PO_SHEET_COLUMNS: ExportColumn[] = [
  { key: "po_no", label: "PO No.", type: "text" },
  { key: "sku_code", label: "SKU Code", type: "text" },
  { key: "sku_name", label: "SKU Name", type: "text" },
  { key: "qty", label: "Quantity", type: "number" },
]

// Splits carry the order they came off and where they're going — see splitSection.
const SPLIT_SHEET_COLUMNS: ExportColumn[] = [
  { key: "po_no", label: "PO No.", type: "text" },
  { key: "reference_po", label: "Split From", type: "text" },
  { key: "sku_code", label: "SKU Code", type: "text" },
  { key: "sku_name", label: "SKU Name", type: "text" },
  { key: "destination", label: "Deliver To", type: "text" },
  { key: "qty", label: "Quantity", type: "number" },
]

function toSheetRows(lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): Record<string, unknown>[] {
  return lines.map((l) => ({ ...l }))
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
  

  const { to, cc } = await resolveRecipients("mfg", mfg.code, mfg.email)
  // Both empty, not just `to`: an internal employee copied on every
  // manufacturer is a real recipient, so a mail with only a CC still goes.
  if (to.length === 0 && cc.length === 0) {
    logger.warn({ ...ctx, mfgId, message: "sendMfgSelectionEmail: manufacturer has no email on file, skipping" })
    return false
  }

  const ongoing = await query<{ id: number; po_no: string; sku_code: string; sku_name: string | null; qty: number; expected_on: string | null; status: string }>(purchaseOrdersSql.ongoingByMfg, [mfgId])
  const openLines: OngoingPoLine[] = ongoing.map((r) => ({
    po_no: r.po_no, sku_code: r.sku_code, sku_name: r.sku_name, qty: Number(r.qty),
  }))

  // Selected lines split into the tables the summary shows — any other selected
  // status (e.g. punched, received) isn't part of this summary. Splits come out
  // of the raised list into their own section: they are raised, but "newly
  // raised" reads as new demand, and a split is a re-issue of demand the
  // manufacturer already has on an order it can be pointed back at.
  const splitLines     = selected.filter((l) => l.status === "raised" && !!l.reference_po)
  const raisedLines    = selected.filter((l) => l.status === "raised" && !l.reference_po)
  const cancelledLines = selected.filter((l) => l.status === "cancelled")

  const attachments: { filename: string; content: Buffer }[] = []
  let pdfsAttached = 0
  for (const line of selected) {
    if (!ATTACHABLE_STATUSES.has(line.status)) continue
    try {
      const data = await fetchPoData(line.id)
      if (!data) continue
      const pdfBuffer = await generatePoPdf(data)
      attachments.push({ filename: `PO-${line.po_no}.pdf`, content: pdfBuffer as unknown as Buffer })
      pdfsAttached++
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ ...ctx, poId: line.id, po_no: line.po_no, error: message, message: "PO PDF generation failed for selection email — sending without this attachment" })
    }
  }

  const xlsxBuffer = await buildMultiSheetXlsx([
    { name: "Raised",    columns: PO_SHEET_COLUMNS,       rows: toSheetRows(raisedLines) },
    { name: "Splits",    columns: SPLIT_SHEET_COLUMNS,    rows: splitLines.map((l) => ({ ...l, reference_po: l.reference_po ?? "", destination: l.destination ?? "" })) },
    { name: "Cancelled", columns: PO_SHEET_COLUMNS,       rows: toSheetRows(cancelledLines) },
    { name: "Open",      columns: PO_SHEET_COLUMNS,       rows: toSheetRows(openLines) },
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

  try {
    await transporter.sendMail({
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
          <p style="color:#555;margin-top:0">Please find the latest status of the following purchase orders${pdfsAttached > 0 ? " (PDFs attached for raised/cancelled POs; full details in the attached Excel)" : " (full details in the attached Excel)"}.</p>
          ${poSection("Newly Raised Purchase Orders", raisedLines)}
          ${splitSection(splitLines)}
          ${poSection("Cancelled Purchase Orders", cancelledLines)}
          ${poSection("Remaining Open Purchase Orders", openLines)}
          <p style="font-size:12px;color:#888;margin-top:20px">
            This is an auto-generated email from the mcaffeine ERP system.
            Please confirm receipt by replying to this email.
          </p>
        </div>
      `,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  } catch (sendErr: unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    const stack = sendErr instanceof Error ? sendErr.stack : undefined
    logger.error({ ...ctx, eventId, err: message, stack, message: "PO selection email send failed" })
    recordFailedEvent("PO_SELECTION_EMAIL", eventId, { mfgId, mfg_name: mfg.name }, message)
    throw sendErr
  }

  logger.info({ ...ctx, eventId, mfgId, mfg_name: mfg.name, mfg_email: allRecipients, message: "PO selection email sent successfully" })
  recordProcessedEvent("PO_SELECTION_EMAIL", eventId, { mfgId, mfg_name: mfg.name, mfg_email: allRecipients })
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
   * buyer_gstin in lib/invoice-inward.ts. Selects that entity's point of contact
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
  /** Signed by whoever filed the invoice, not a name baked into the repo. */
  senderName: string
}

/**
 * Notify the receiving warehouse that an invoice has been inwarded.
 *
 * Returns false (rather than throwing) when there's no one to send to — a
 * warehouse with no email on file is a data gap, not a failure of the invoice,
 * which is already committed by the time this runs.
 */
export async function sendInwardInvoiceEmail(mail: InwardInvoiceMail): Promise<boolean> {
  const ctx = mailerCtx()
  const { mfgId, destination, facility, legalEntityCode, invoiceNo, invoiceDate, uniwarePoCode, invoicePdf, items, senderName } = mail

  // Only for the subject line — the manufacturer is not a recipient here.
  const mfgRows = await query<{ code: string; name: string }>(
    `SELECT code, name FROM master_mfgs WHERE id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, message: "sendInwardInvoiceEmail: manufacturer not found" })
    return false
  }

  // Shared warehouse addresses plus this legal entity's own point of contact.
  const { to, cc } = await resolveRecipients("warehouse", destination, null, legalEntityCode ?? null)
  // Both empty, not just `to`: an employee attached to this site is a real
  // recipient, so a CC-only notification still goes out.
  if (to.length === 0 && cc.length === 0) {
    logger.warn({
      ...ctx, mfgId, destination, legalEntityCode,
      message: "sendInwardInvoiceEmail: warehouse has no email on file, skipping",
    })
    return false
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
  // mail rather than blocking it.
  if (uniwarePoCode) {
    try {
      const poPdf = await fetchPurchaseOrderPdf(uniwarePoCode ,facility)
      // Codes carry slashes (GM/2627/PO/2006) — not a filename.
      const safeCode = uniwarePoCode.replace(/[^a-zA-Z0-9._-]/g, "-")
      attachments.push({ filename: `Uniware-PO-${safeCode}.pdf`, content: poPdf })
    } catch (err: unknown) {
      logger.error({
        ...ctx, mfgId, destination, invoiceNo, uniwarePoCode,
        err: err instanceof Error ? err.message : String(err),
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

  try {
    await transporter.sendMail({
      ...sesOptions,
      from: fromHeader,
      to: to.join(", "),
      // Omitted entirely when empty — nodemailer throws on a blank Cc.
      ...(cc.length ? { cc: cc.join(", ") } : {}),
      subject,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:auto;color:#111;font-size:14px;line-height:1.6">
          <p style="margin:0">PFA</p>
          ${uniwarePoCode ? `<p style="margin:12px 0 0;font-weight:600">${escapeHtml(uniwarePoCode)}</p>` : ""}
          ${poSection(`Items Inwarded at ${escapeHtml(destination)}`, items)}
          <p style="margin:20px 0 0">Thanks &amp; Regards<br>${escapeHtml(senderName)}<br>${escapeHtml(MAIL_SIGNATURE_TITLE)}</p>
        </div>
      `,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  } catch (sendErr: unknown) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr)
    logger.error({ ...ctx, eventId, mfgId, destination, invoiceNo, err: message, message: "Inward invoice email send failed" })
    recordFailedEvent("PO_INWARD_INVOICE_EMAIL", eventId, { mfgId, destination, invoiceNo }, message)
    throw sendErr
  }

  logger.info({
    ...ctx, eventId, mfgId, mfg_name: mfg.name, destination, invoiceNo, uniwarePoCode,
    warehouse_email: allRecipients, message: "Inward invoice email sent to warehouse",
  })
  recordProcessedEvent("PO_INWARD_INVOICE_EMAIL", eventId, { mfgId, destination, invoiceNo, uniwarePoCode })
  return true
}
