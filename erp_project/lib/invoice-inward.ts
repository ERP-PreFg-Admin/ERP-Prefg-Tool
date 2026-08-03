/**
 * Invoice → inward POs: the whole committed sequence, in order.
 *
 *   1. s3       store the original PDF
 *   2. po       our rows — invoice header, line items, inward POs, receipts
 *   3. uniware  mirror to Unicommerce as ONE PO carrying every SKU
 *   4. email    notify the manufacturer
 *
 * ── On atomicity ────────────────────────────────────────────────────────────
 * S3 objects, Uniware POs and sent email are not transactional resources; a
 * database rollback cannot undo any of them. What this module does instead is
 * order the steps least-reversible-last and compensate on the way out:
 *
 *   s3       reversible  — deleteFile()
 *   po       reversible  — conn.rollback()
 *   uniware  NOT reversible — Uniware exposes no cancel/delete for a PO, which
 *                             is exactly why it runs while the transaction is
 *                             still open: if it fails, the DB rolls back and the
 *                             S3 object is removed, and nothing was created
 *                             upstream because the call itself failed.
 *   email    NOT reversible — so it runs last, after commit, and its failure is
 *                             reported without undoing anything. The goods are
 *                             physically here; a missed notification is not a
 *                             reason to discard the receipt.
 *
 * The cost of holding the transaction open across the Uniware call is row locks
 * held for a second or two. Acceptable for a desk operation at this volume; it
 * would not be for a hot path.
 *
 * Progress is reported through `emit` so the caller can stream it, keeping this
 * module free of any HTTP concern.
 */

import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { deleteFile, uploadFile } from "@/lib/s3"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { supplierInvoicesSql } from "@/lib/queries/supplier-invoices"
import { manufacturers as manufacturersSql } from "@/lib/queries/manufacturers"
import { skus as skusSql } from "@/lib/queries/skus"
import { receivePo } from "@/lib/po-receive"
import { createPurchaseOrder, futureDeliveryDate, uniwareEnabled } from "@/lib/uniware"
import { UNIWARE_VENDOR_CODE } from "@/lib/env"
import { sendInwardInvoiceEmail } from "@/lib/mailer"
import { ApiError } from "@/lib/gateway/errors"
import logger from "@/lib/logger"
import type { InvoiceInward } from "@/lib/validation/purchase-orders"

export const INWARD_STEPS = ["s3", "po", "uniware", "email"] as const
export type InwardStep = (typeof INWARD_STEPS)[number]

export type StepEvent = {
  step: InwardStep
  status: "start" | "ok" | "failed" | "skipped"
  message?: string
  data?: unknown
}

export type Emit = (e: StepEvent) => void | Promise<void>

export type InwardOutcome = {
  ok: boolean
  attachment_key?: string
  created: { id: number; po_no: string; sku_code: string }[]
  received: { id: number; po_no: string; qty: number; status: string }[]
  uniwarePoCode?: string
  error?: string
  /** Which step failed, when ok is false. */
  failedStep?: InwardStep
}

// Same mapping the single-PO route uses, so an inward PO number is recognisable
// alongside the ones procurement raises.
const BRAND_CODES: Record<string, string> = { mcaffeine: "MCAFF", hyphen: "HYP" }

const numOrNull = (v: unknown) =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v)

/** Validate SKUs and resolve each one's brand, before any transaction opens. */
async function resolveBrands(skuCodes: string[]): Promise<Map<string, string>> {
  const brandBySku = new Map<string, string>()
  for (const sku of skuCodes) {
    if (brandBySku.has(sku)) continue
    const rows = await query<{ status: string; brand: string | null }>(
      skusSql.selectStatusAndBrandByCode, [sku]
    )
    if (!rows[0]) {
      throw new ApiError(400, "sku_not_found", `SKU '${sku}' was not found. Map it to an existing SKU and try again.`)
    }
    if (rows[0].status !== "active") {
      throw new ApiError(
        400, "sku_not_active",
        `SKU '${sku}' is currently '${rows[0].status.replace(/_/g, " ")}' and cannot be used for a new PO.`
      )
    }
    const raw = rows[0].brand?.trim() || sku.split("-")[0]
    brandBySku.set(sku, (BRAND_CODES[raw.toLowerCase()] ?? raw).toUpperCase())
  }
  return brandBySku
}

/** Step 2's database work. Runs inside the caller's open transaction. */
async function writeInvoiceAndPos(
  conn: PoolConnection,
  body: InvoiceInward,
  attachmentKey: string,
  userId: number,
  brandBySku: Map<string, string>
) {
  const { invoice_no, invoice_date, mfg_id, destination, line_items } = body
  const now = new Date()
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`
  // Goods on an invoice have already shipped, so the expected date is the
  // invoice's own — backdated on purpose.
  const expectedOn = invoice_date?.trim() || now.toISOString().slice(0, 10)

  // Header first: uq_supplier_invoice (mfg_id, invoice_no) rejects a
  // re-submission, and it has to fire before any receipt is credited or the
  // duplicate would inflate received_qty on its way to the error.
  const [invRes] = await conn.execute(supplierInvoicesSql.insertHeader, [
    Number(mfg_id), invoice_no, invoice_date?.trim() || null,
    body.currency, body.eway_bill_no, body.vehicle_no, body.po_ref,
    body.seller_gstin, body.buyer_gstin,
    body.bill_to_name, body.bill_to_address, body.bill_to_state,
    body.ship_to_name, body.ship_to_address,
    destination, numOrNull(body.invoice_total), attachmentKey, userId,
  ])
  const invoiceId = (invRes as { insertId: number }).insertId

  const created: InwardOutcome["created"] = []
  const receivedOut: InwardOutcome["received"] = []
  const poLines: { id: number; po_no: string; sku_code: string; qty: number; unitPrice: number | null; mrp: number | null }[] = []
  const lineLinks: { poId: number; receivedAgainstPoId: number | null; linkType: "created" | "received" }[] = []

  const nextSeq = new Map<string, number>()
  /** Seeds lazily: a brand reached only via a received line comes from the
   *  parent PO's number, which the SKU pass never saw. */
  const nextPoNo = async (brand: string) => {
    if (!nextSeq.has(brand)) {
      const [rows] = await conn.execute(purchaseOrdersSql.countByPrefix, [`${brand}-INW-${yyyymm}-%`])
      nextSeq.set(brand, Number((rows as { cnt: number }[])[0]?.cnt ?? 0) + 1)
    }
    const seq = nextSeq.get(brand)!
    nextSeq.set(brand, seq + 1)
    return `${brand}-INW-${yyyymm}-${String(seq).padStart(3, "0")}`
  }

  for (const item of line_items) {
    const qty = Number(item.qty)
    const unitPrice = numOrNull(item.unit_price)
    // Fall back to rate x qty so Amount isn't blank when the invoice printed
    // only a per-unit rate.
    const totalAmount = numOrNull(item.total_amount) ?? (unitPrice != null ? unitPrice * qty : null)

    if (item.reference_po_id != null) {
      // Credit the existing order and still raise an inward PO, so every
      // invoice line is visible in the PO table.
      const refPoId = Number(item.reference_po_id)
      const r = await receivePo(conn, refPoId, qty, userId)
      receivedOut.push({ id: refPoId, po_no: r.po_no, qty, status: r.status })

      // Brand from the parent's number: a received line needn't carry a SKU.
      const brand = r.po_no.split("-")[0] || "INW"
      const po_no = await nextPoNo(brand)
      const skuCode = r.sku_code ?? item.sku_code?.trim() ?? null

      const [res] = await conn.execute(purchaseOrdersSql.insertInwardReceived, [
        po_no, Number(mfg_id), skuCode, qty, unitPrice, totalAmount,
        expectedOn, destination, invoice_no, attachmentKey, qty, r.po_no,
      ])
      const poId = (res as { insertId: number }).insertId
      await conn.execute(purchaseOrdersSql.insertPoHistory, [
        poId, po_no, "create", null, null, null, attachmentKey, userId,
      ])

      created.push({ id: poId, po_no, sku_code: skuCode ?? "" })
      poLines.push({ id: poId, po_no, sku_code: skuCode ?? "", qty, unitPrice, mrp: numOrNull(item.mrp) })
      lineLinks.push({ poId, receivedAgainstPoId: refPoId, linkType: "received" })
      continue
    }

    const skuCode = item.sku_code?.trim() ?? ""
    const po_no = await nextPoNo(brandBySku.get(skuCode)!)
    const [res] = await conn.execute(purchaseOrdersSql.insertInward, [
      po_no, Number(mfg_id), skuCode, qty, unitPrice, totalAmount,
      expectedOn, destination, invoice_no, attachmentKey,
    ])
    const poId = (res as { insertId: number }).insertId
    await conn.execute(purchaseOrdersSql.insertPoHistory, [
      poId, po_no, "create", null, null, null, attachmentKey, userId,
    ])

    created.push({ id: poId, po_no, sku_code: skuCode })
    poLines.push({ id: poId, po_no, sku_code: skuCode, qty, unitPrice, mrp: numOrNull(item.mrp) })
    lineLinks.push({ poId, receivedAgainstPoId: null, linkType: "created" })
  }

  // One row per invoice line, each tagged to the PO it resolved to. After the
  // loop because a receipt line only learns its PO id from receivePo.
  for (const [i, item] of line_items.entries()) {
    const link = lineLinks[i]
    await conn.execute(supplierInvoicesSql.insertItem, [
      invoiceId, i + 1, link.poId, link.receivedAgainstPoId, link.linkType,
      item.sku_code?.trim() || null, item.parsed_sku_code, item.sku_name,
      item.batch, item.mfg_date, item.expiry, item.hsn,
      Number(item.qty),
      numOrNull(item.rate ?? item.unit_price), numOrNull(item.mrp),
      numOrNull(item.discount), numOrNull(item.gst_percent),
      numOrNull(item.amount), numOrNull(item.total_amount),
    ])
  }

  return { invoiceId, created, received: receivedOut, poLines, expectedOn }
}

/**
 * Run the full sequence. Never throws for step failures — the outcome says what
 * happened and `emit` has already reported each step.
 */
export async function runInwardInvoice(
  body: InvoiceInward,
  pdf: { buffer: Buffer; filename: string },
  /** Who filed it — the notification is signed with their name. */
  user: { id: number; name: string },
  emit: Emit
): Promise<InwardOutcome> {
  const userId = user.id
  const senderName = user.name
  const { invoice_no, mfg_id, line_items } = body

  // Validated before anything is written: a rejected batch shouldn't leave an
  // S3 object behind or hold a connection while we round-trip the SKU master.
  const newSkus = line_items.filter((i) => i.reference_po_id == null).map((i) => i.sku_code?.trim() ?? "")
  if (newSkus.some((s) => !s)) {
    throw new ApiError(400, "sku_required", "Every line item needs a mapped SKU or a reference PO.")
  }
  const brandBySku = await resolveBrands(newSkus)

  const mfgRows = await query<{ code: string; name: string }>(manufacturersSql.selectById, [Number(mfg_id)])
  const mfgCode = mfgRows[0]?.code ?? ""

  // ── 1. S3 ─────────────────────────────────────────────────────────────────
  await emit({ step: "s3", status: "start" })
  let attachmentKey = ""
  try {
    const yyyymm = new Date().toISOString().slice(0, 7)
    const safe = pdf.filename.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60)
    attachmentKey = `invoices/${yyyymm}/${safe}-${crypto.randomUUID().slice(0, 8)}.pdf`
    await uploadFile(pdf.buffer, attachmentKey, "application/pdf")
    await emit({ step: "s3", status: "ok", message: "Invoice stored", data: { key: attachmentKey } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emit({ step: "s3", status: "failed", message })
    return { ok: false, created: [], received: [], error: message, failedStep: "s3" }
  }

  /** Undo the S3 write — the only compensating action available to us. */
  const dropS3 = async () => {
    try { await deleteFile(attachmentKey) } catch (e) {
      logger.error({ module: "PO_INVOICE", key: attachmentKey, err: String(e), message: "Could not remove orphaned invoice PDF" })
    }
  }

  const conn: PoolConnection = await pool.getConnection()
  await conn.beginTransaction()

  let written: Awaited<ReturnType<typeof writeInvoiceAndPos>>
  // ── 2. Our rows ───────────────────────────────────────────────────────────
  await emit({ step: "po", status: "start" })
  try {
    written = await writeInvoiceAndPos(conn, body, attachmentKey, userId, brandBySku)
    await emit({
      step: "po", status: "ok",
      message: `${written.created.length} inward PO(s), ${written.received.length} received against`,
      data: { created: written.created, received: written.received },
    })
  } catch (err) {
    await conn.rollback()
    conn.release()
    await dropS3()
    const message = describeDbError(err, invoice_no)
    await emit({ step: "po", status: "failed", message })
    return { ok: false, created: [], received: [], error: message, failedStep: "po" }
  }

  // ── 3. Uniware — still inside the transaction, so a failure undoes step 2 ──
  //
  // No purchaseOrderCode is sent: the facility's own series numbers the PO
  // (GM/2627/PO/2006 and the like), and that is the reference the manufacturer
  // recognises. Uniware returns it on create and we keep it.
  //
  // The trade-off is idempotency. Supplying our own code made a retry provably
  // safe, because Uniware rejects duplicates. The exposed window now is narrow
  // but real: if the create succeeds and the commit below then fails, the
  // rollback leaves an orphan PO in Uniware and a retry mints a second one.
  // Reconcile on uniware_po_code if that ever happens.
  let uniwarePoCode: string | null = null
  await emit({ step: "uniware", status: "start" })
  if (!uniwareEnabled()) {
    await emit({ step: "uniware", status: "skipped", message: "Uniware is not configured" })
  } else {
    try {
      // ONE Uniware PO carrying every SKU — unlike our side, where the model is
      // one PO per SKU.
      const res = await createPurchaseOrder({
        vendorCode: UNIWARE_VENDOR_CODE || mfgCode,
        currencyCode: body.currency || "INR",
        // Almost always omitted here: expectedOn is the invoice date, which is
        // in the past because the goods have already shipped, and Uniware only
        // accepts a future deliveryDate. The real date rides in a custom field
        // below rather than being faked forward.
        deliveryDate: futureDeliveryDate(written.expectedOn),
        items: written.poLines.map((l) => ({
          itemSKU: l.sku_code,
          quantity: l.qty,
          unitPrice: l.unitPrice ?? 0,
          maxRetailPrice: l.mrp,
        })),
        customFields: { invoiceNo: invoice_no, invoiceDate: written.expectedOn },
      })
      uniwarePoCode = res.purchaseOrderCode
      // Persisted inside the transaction, so an invoice can never commit
      // claiming a Uniware PO that isn't there — and the code survives the
      // request, which is the only place it exists otherwise.
      await conn.execute(supplierInvoicesSql.setUniwarePoCode, [uniwarePoCode, written.invoiceId])
      await emit({ step: "uniware", status: "ok", message: `Created ${uniwarePoCode}`, data: { uniwarePoCode } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await conn.rollback()
      conn.release()
      await dropS3()
      await emit({ step: "uniware", status: "failed", message })
      return { ok: false, created: [], received: [], error: message, failedStep: "uniware" }
    }
  }

  // Past this line nothing can be undone.
  try {
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    conn.release()
    await dropS3()
    const message = err instanceof Error ? err.message : String(err)
    await emit({ step: "po", status: "failed", message: `Commit failed: ${message}` })
    return { ok: false, created: [], received: [], error: message, failedStep: "po" }
  }
  conn.release()

  // ── 4. Email — after commit, and never a reason to undo ───────────────────
  await emit({ step: "email", status: "start" })
  try {
    // Not the PO-status mail procurement sends: the manufacturer already knows
    // the order. What they need is the paperwork for goods that have arrived,
    // so the invoice we just read goes out as the attachment. Reused from the
    // buffer already in hand rather than re-fetched from S3.
    const sent = await sendInwardInvoiceEmail({
      mfgId: Number(mfg_id),
      invoiceNo: invoice_no,
      invoiceDate: body.invoice_date?.trim() || null,
      // Null when the mirror was skipped — quoting a reference the
      // manufacturer can't look up is worse than omitting the line.
      uniwarePoCode,
      invoicePdf: { filename: pdf.filename, content: pdf.buffer },
      senderName,
    })
    await emit(
      sent
        ? { step: "email", status: "ok", message: "Manufacturer notified" }
        : { step: "email", status: "skipped", message: "No email on file for this manufacturer" }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ module: "PO_INVOICE", invoice_no, err: message, message: "Invoice notification email failed" })
    // Reported, not fatal: the goods are received and both systems hold the POs.
    await emit({ step: "email", status: "failed", message })
  }

  return {
    ok: true,
    attachment_key: attachmentKey,
    created: written.created,
    received: written.received,
    uniwarePoCode: uniwarePoCode ?? undefined,
  }
}

/** Turn a driver error into something the desk can act on. */
function describeDbError(err: unknown, invoiceNo: string): string {
  if (err instanceof ApiError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
    if (message.includes("uq_supplier_invoice")) {
      return `Invoice ${invoiceNo} has already been entered for this manufacturer. Nothing was created or received.`
    }
    return "A PO number collided with a concurrent request. Please try again."
  }
  return message
}
