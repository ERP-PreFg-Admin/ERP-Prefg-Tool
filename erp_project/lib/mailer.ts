import nodemailer from "nodemailer"
import { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_SIGNATURE_TITLE } from "@/lib/env"
import { query } from "@/lib/db"
import { generatePoPdf, type PoEmailData } from "@/lib/pdf/po-document"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { entityEmails } from "@/lib/queries/entity-emails"
import { fetchPurchaseOrderPdf } from "@/lib/uniware"
import { buildMultiSheetXlsx, type ExportColumn } from "@/lib/export"
import { recordRawEvent, recordProcessedEvent, recordFailedEvent, makeEventId } from "@/lib/events"
import logger from "@/lib/logger"
import crypto from "crypto"

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
  secure: true,
})

const ctx = {
  module: "MAILER",
  requestId: crypto.randomUUID(),
}

type PoEmailRow = {
  po_no: string
  date: string | null
  expected_on: string | null
  destination: string | null
  dest_location: string | null
  sku_code: string
  sku_name: string | null
  qty: number | string
  unit_price: number | string | null
  total_amount: number | string | null
  mfg_name: string
  mfg_code: string
  registered_name: string | null
  gst_number: string | null
  location: string | null
  mfg_email: string | null
  raised_by_name: string | null
}

export async function fetchPoData(poId: number): Promise<PoEmailData | null> {
  const rows = await query<PoEmailRow>(purchaseOrdersSql.selectForEmail, [poId])
  const po = rows[0]
  if (!po) return null
  return {
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
  primaryEmail: string | null = null
): Promise<string[]> {
  const rows = await query<{ email: string }>(entityEmails.selectByEntity, [entityType, entityCode])
  const seen = new Set<string>()
  const recipients: string[] = []
  for (const raw of [primaryEmail, ...rows.map((r) => r.email)]) {
    const email = raw?.trim()
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    recipients.push(email)
  }
  return recipients
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
  const mfgRows = await query<{ code: string; name: string; email: string | null }>(
    `SELECT m.code, m.name, d.email FROM master_mfgs m JOIN details_mfg d ON d.mfg_id = m.id WHERE m.id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, message: "sendMfgSelectionEmail: manufacturer not found" })
    return false
  }

  const recipients = await resolveRecipients("mfg", mfg.code, mfg.email)
  if (recipients.length === 0) {
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

  const eventId = makeEventId("PO_SELECTION_EMAIL", "send", mfgId)
  recordRawEvent("PO_SELECTION_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, mfg_email: recipients.join(", "), selectedCount: selected.length, attachmentCount: attachments.length,
  })

  try {
    await transporter.sendMail({
      from: `mcaffeine ERP <${GMAIL_USER}>`,
      to: recipients.join(", "),
      subject: `PO Update — ${mfg.name}`,
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

  logger.info({ ...ctx, eventId, mfgId, mfg_name: mfg.name, mfg_email: recipients.join(", "), message: "PO selection email sent successfully" })
  recordProcessedEvent("PO_SELECTION_EMAIL", eventId, { mfgId, mfg_name: mfg.name, mfg_email: recipients.join(", ") })
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
  const { mfgId, destination, invoiceNo, invoiceDate, uniwarePoCode, invoicePdf, items, senderName } = mail

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

  const recipients = await resolveRecipients("warehouse", destination)
  if (recipients.length === 0) {
    logger.warn({
      ...ctx, mfgId, destination,
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
      const poPdf = await fetchPurchaseOrderPdf(uniwarePoCode)
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

  const eventId = makeEventId("PO_INWARD_INVOICE_EMAIL", "send", mfgId)
  recordRawEvent("PO_INWARD_INVOICE_EMAIL", eventId, {
    mfgId, mfg_name: mfg.name, destination, invoiceNo, uniwarePoCode,
    warehouse_email: recipients.join(", "), attachmentCount: attachments.length,
  })

  try {
    await transporter.sendMail({
      from: `mcaffeine ERP <${GMAIL_USER}>`,
      to: recipients.join(", "),
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
    warehouse_email: recipients.join(", "), message: "Inward invoice email sent to warehouse",
  })
  recordProcessedEvent("PO_INWARD_INVOICE_EMAIL", eventId, { mfgId, destination, invoiceNo, uniwarePoCode })
  return true
}
