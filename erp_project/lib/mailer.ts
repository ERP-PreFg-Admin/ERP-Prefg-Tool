import nodemailer from "nodemailer"
import { GMAIL_USER, GMAIL_APP_PASSWORD, APP_URL } from "@/lib/env"
import { query } from "@/lib/db"
import { generatePoPdf, type PoEmailData } from "@/lib/pdf/po-document"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { entityEmails } from "@/lib/queries/entity-emails"
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
 * All email addresses to notify for a manufacturer: the single primary
 * contact on details_mfg.email (if set) plus every address entered against
 * this manufacturer in the entity_emails contact list (/po-tracking/
 * po-procurement/entity-emails) — deduped case-insensitively.
 */
export async function resolveMfgRecipients(mfgCode: string, primaryEmail: string | null): Promise<string[]> {
  const rows = await query<{ email: string }>(entityEmails.selectByEntity, ["mfg", mfgCode])
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

type SelectedPoLine = { id: number; po_no: string; sku_code: string; sku_name: string | null; qty: number; status: string }
type OngoingPoLine = { po_no: string; sku_code: string; sku_name: string | null; qty: number }

// Statuses worth attaching a PDF copy for — the two actions this flow exists
// to notify manufacturers about. Other selected statuses (received, punched,
// etc.) just show up in the summary table with no attachment.
const ATTACHABLE_STATUSES = new Set(["raised", "cancelled"])

function poTableRows(lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): string {
  return lines
    .map(
      (l) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${l.po_no}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${l.sku_code}${l.sku_name ? " — " + l.sku_name : ""}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">${Number(l.qty).toLocaleString("en-IN")}</td>
        </tr>`
    )
    .join("")
}

function poSection(title: string, lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): string {
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
  { key: "link", label: "PO Link", type: "text" },
]

function toSheetRows(lines: { po_no: string; sku_code: string; sku_name: string | null; qty: number }[]): Record<string, unknown>[] {
  return lines.map((l) => ({
    ...l,
    link: `${APP_URL}/po-tracking/po-procurement?search=${encodeURIComponent(l.po_no)}`,
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
  const mfgRows = await query<{ code: string; name: string; email: string | null }>(
    `SELECT m.code, m.name, d.email FROM master_mfgs m JOIN details_mfg d ON d.mfg_id = m.id WHERE m.id = ? LIMIT 1`,
    [mfgId]
  )
  const mfg = mfgRows[0]
  if (!mfg) {
    logger.warn({ ...ctx, mfgId, message: "sendMfgSelectionEmail: manufacturer not found" })
    return false
  }

  const recipients = await resolveMfgRecipients(mfg.code, mfg.email)
  if (recipients.length === 0) {
    logger.warn({ ...ctx, mfgId, message: "sendMfgSelectionEmail: manufacturer has no email on file, skipping" })
    return false
  }

  const ongoing = await query<{ id: number; po_no: string; sku_code: string; sku_name: string | null; qty: number; expected_on: string | null; status: string }>(purchaseOrdersSql.ongoingByMfg, [mfgId])
  const openLines: OngoingPoLine[] = ongoing.map((r) => ({
    po_no: r.po_no, sku_code: r.sku_code, sku_name: r.sku_name, qty: Number(r.qty),
  }))

  // Selected lines split into the three tables the summary shows — any other
  // selected status (e.g. punched, received) isn't part of this summary.
  const raisedLines    = selected.filter((l) => l.status === "raised")
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
    { name: "Raised",    columns: PO_SHEET_COLUMNS, rows: toSheetRows(raisedLines) },
    { name: "Cancelled", columns: PO_SHEET_COLUMNS, rows: toSheetRows(cancelledLines) },
    { name: "Open",      columns: PO_SHEET_COLUMNS, rows: toSheetRows(openLines) },
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
