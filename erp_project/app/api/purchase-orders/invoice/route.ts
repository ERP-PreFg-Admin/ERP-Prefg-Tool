// POST /api/purchase-orders/invoice
// Turn a reviewed supplier invoice into inward POs — one purchase_orders row
// per line item, all sharing the invoice number and the S3 key of the original
// PDF. Raised immediately: the invoice is the authorisation, so unlike an
// impromptu PO there's nothing to approve.
//
// All-or-nothing. Every SKU is validated before anything is written, and the
// whole batch rolls back on any failure — a half-created invoice would leave
// the inwarding desk reconciling against a document that no longer matches.

import { NextResponse } from "next/server"
import type { PoolConnection } from "mysql2/promise"
import { query, pool } from "@/lib/db"
import { purchaseOrdersSql } from "@/lib/queries/purchase-orders"
import { skus as skusSql } from "@/lib/queries/skus"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { invoiceInwardSchema } from "@/lib/validation/purchase-orders"
import { receivePo } from "@/lib/po-receive"
import { makeEventId, recordRawEvent, recordProcessedEvent, recordFailedEvent } from "@/lib/events"
import logger from "@/lib/logger"

// Same mapping the single-PO route uses, so an inward PO number is recognisable
// alongside the ones procurement raises.
const BRAND_CODES: Record<string, string> = {
  mcaffeine: "MCAFF",
  hyphen:    "HYP",
}

export const POST = withGateway({
  schema: invoiceInwardSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body, session, ctx }) => {
    const userId = Number(session.user.id)
    const { attachment_key, invoice_no, invoice_date, mfg_id, destination, line_items } = body

    const eventId = makeEventId("PO_INVOICE", "create")
    recordRawEvent("PO_INVOICE", eventId, {
      invoice_no, mfg_id, destination, attachment_key, lineItems: line_items.length,
    })

    // Lines that reference an existing PO are booked as receipts against it and
    // never become new PO rows, so they're excluded from SKU validation and
    // PO-number allocation below.
    const newPoItems = line_items.filter((i) => i.reference_po_id == null)

    // ── Validate every SKU up front ──────────────────────────────────────────
    // Before opening a transaction: a rejected batch shouldn't hold a connection
    // or a row lock while we round-trip the SKU master once per line.
    const brandBySku = new Map<string, string>()
    for (const item of newPoItems) {
      if (brandBySku.has(item.sku_code)) continue
      const rows = await query<{ status: string; brand: string | null }>(
        skusSql.selectStatusAndBrandByCode, [item.sku_code]
      )
      if (!rows[0]) {
        throw new ApiError(400, "sku_not_found", `SKU '${item.sku_code}' was not found. Map it to an existing SKU and try again.`)
      }
      if (rows[0].status !== "active") {
        throw new ApiError(
          400,
          "sku_not_active",
          `SKU '${item.sku_code}' is currently '${rows[0].status.replace(/_/g, " ")}' and cannot be used for a new PO.`
        )
      }
      const rawBrand = rows[0].brand?.trim() || item.sku_code.split("-")[0]
      brandBySku.set(item.sku_code, (BRAND_CODES[rawBrand.toLowerCase()] ?? rawBrand).toUpperCase())
    }

    // ── PO numbers: {BRAND}-INW-{yyyymm}-{nnn}, sequence scoped per brand+month ──
    // countByPrefix can't see rows this request hasn't committed yet, so the
    // per-prefix counter is advanced in memory as each line consumes a number.
    const now     = new Date()
    const yyyymm  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`
    const nextSeq = new Map<string, number>()
    for (const brand of brandBySku.values()) {
      if (nextSeq.has(brand)) continue
      const countRows = await query<{ cnt: number }>(purchaseOrdersSql.countByPrefix, [`${brand}-INW-${yyyymm}-%`])
      nextSeq.set(brand, Number(countRows[0]?.cnt ?? 0) + 1)
    }

    // Goods on an invoice have already shipped, so the expected date is the
    // invoice's own date — backdated on purpose, which is why this route has
    // its own schema instead of reusing poCreateSchema's no-backdating rule.
    const expectedOn = invoice_date?.trim() || now.toISOString().slice(0, 10)

    const conn: PoolConnection = await pool.getConnection()
    await conn.beginTransaction()
    try {
      const created: { id: number; po_no: string; sku_code: string }[] = []
      const received: { id: number; po_no: string; qty: number; status: string }[] = []

      for (const item of line_items) {
        // Referenced line → book a receipt, don't mint a PO. receivePo does the
        // FOR UPDATE lock, the over-receipt check, the tolerance auto-close and
        // the history row; it throws ApiError, which rolls the whole batch back.
        if (item.reference_po_id != null) {
          const r = await receivePo(conn, Number(item.reference_po_id), Number(item.qty), userId)
          received.push({
            id: Number(item.reference_po_id),
            po_no: r.po_no,
            qty: Number(item.qty),
            status: r.status,
          })
          continue
        }

        const brand = brandBySku.get(item.sku_code)!
        const seq   = nextSeq.get(brand)!
        nextSeq.set(brand, seq + 1)
        const po_no = `${brand}-INW-${yyyymm}-${String(seq).padStart(3, "0")}`

        const qty        = Number(item.qty)
        const unitPrice  = item.unit_price   != null && item.unit_price   !== "" ? Number(item.unit_price)   : null
        // Fall back to rate x qty so the Amount column isn't blank when the
        // invoice only printed a per-unit rate.
        const totalAmount = item.total_amount != null && item.total_amount !== ""
          ? Number(item.total_amount)
          : unitPrice != null ? unitPrice * qty : null

        const [res] = await conn.execute(purchaseOrdersSql.insertInward, [
          po_no, Number(mfg_id), item.sku_code, qty, unitPrice, totalAmount,
          expectedOn, destination, invoice_no, attachment_key,
        ])
        const poId = (res as { insertId: number }).insertId

        await conn.execute(purchaseOrdersSql.insertPoHistory, [
          poId, po_no, "create", null, null, null, attachment_key, userId,
        ])

        created.push({ id: poId, po_no, sku_code: item.sku_code })
      }

      await conn.commit()

      logger.info({
        ...ctx, eventId, invoice_no, attachment_key,
        poNos: created.map((c) => c.po_no),
        receivedPoNos: received.map((r) => r.po_no),
        message: `Invoice processed — ${created.length} inward PO(s) created, ${received.length} received against`,
      })
      recordProcessedEvent("PO_INVOICE", eventId, { invoice_no, attachment_key, created, received })

      return NextResponse.json({
        ok: true, created, received,
        count: created.length, receivedCount: received.length,
      })
    } catch (err: unknown) {
      await conn.rollback()
      if (err instanceof ApiError) throw err
      const message = err instanceof Error ? err.message : String(err)
      const stack   = err instanceof Error ? err.stack : undefined
      logger.error({ ...ctx, eventId, invoice_no, err: message, stack, message: "Inward PO create failed" })
      recordFailedEvent("PO_INVOICE", eventId, { invoice_no, mfg_id, destination }, message)
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "duplicate", "A PO number collided with a concurrent request. Please click OK again.")
      }
      throw new ApiError(500, "internal", "Database error: " + message)
    } finally {
      conn.release()
    }
  },
})
