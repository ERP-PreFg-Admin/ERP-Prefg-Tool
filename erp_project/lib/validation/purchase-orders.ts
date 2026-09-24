import { z } from "zod"
import { todayIST } from "@/lib/date"
import { MATCH_TOLERANCE } from "@/lib/invoice/three-way"

/** CSV rows arrive as raw strings from CsvImportDialog's client-side parse; the
 * route re-serializes them to CSV, uploads to S3, and stages a PO_BULK
 * approval — poBulkHandler.applyAndArchive does the real create/update. */
export const poBulkSchema = z.object({
  action: z.literal("bulk"),
  rows: z.array(z.record(z.string(), z.string())),
})

export const poCreateSchema = z
  .object({
    mfg_id: z.union([z.number(), z.string()]).refine((v) => String(v).trim().length > 0, {
      message: "Manufacturer is required.",
    }),
    sku_code: z.string().trim().min(1, "SKU is required."),
    // Which recipe the PO is against. Required, so every PO can be traced back
    // to what was actually meant to be made; the route additionally checks the
    // Recipe belongs to this SKU and this manufacturer.
    recipe_id: z.coerce.number().int().positive("Recipe is required."),
    qty: z.union([z.number(), z.string()]),
    unit_price: z.union([z.number(), z.string()]).optional().nullable(),
    total_amount: z.union([z.number(), z.string()]).optional().nullable(),
    expected_on: z.string().trim().optional().nullable(),
    destination: z.string().trim().optional().nullable(),
    // Stored on purchase_orders.remarks — capped to that column's width.
    reason: z.string().trim().max(300, "Remarks must be 300 characters or fewer.").optional().nullable(),
    po_type: z.enum(["normal", "impromptu"]).optional().default("impromptu"),
  })
  .refine((v) => Number(v.qty) > 0, {
    message: "Quantity must be greater than 0.",
    path: ["qty"],
  })
  .refine(
    (v) => {
      if (!v.expected_on) return true
      const today = todayIST()
      return v.expected_on >= today
    },
    { message: "Backdating is not allowed for expected dispatch date.", path: ["expected_on"] }
  )
  .refine(
    (v) => v.po_type !== "impromptu" || (v.reason?.trim() ?? "").length > 0,
    { message: "Remarks are required for Impromptu POs.", path: ["reason"] }
  )

export const poActionSchema = z.union([poBulkSchema, poCreateSchema])

// /api/v2/purchase-orders/invoice/parse takes the PDF as multipart/form-data and
// validates it in the route — nothing is in S3 at parse time, so there's no key
// to schema-check here.

/** Optional free-text field off a document: trimmed, length-capped to match the
 *  column, and normalised to null so an empty input doesn't store "". */
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().nullable()
    .transform((v): string | null => (v ? v : null))

/**
 * POST /api/v1/purchase-orders/invoice — the reviewed, user-corrected invoice.
 *
 * Deliberately NOT an extension of poCreateSchema: that one forbids backdating
 * expected_on, and an inward PO is retroactive by definition — the goods were
 * dispatched before anyone opened this dialog.
 */
export const invoiceInwardSchema = z.object({
  // No attachment_key: the PDF is posted as multipart alongside this payload and
  // stored server-side as step 1 of the commit, so the client never has a key.
  invoice_no:     z.string().trim().min(1, "Invoice number is required."),
  invoice_date:   z.string().trim().optional().nullable(),
  mfg_id:         z.union([z.number(), z.string()]).refine((v) => String(v).trim().length > 0, {
    message: "Manufacturer is required.",
  }),
  destination:    z.string().trim().min(1, "Destination is required."),

  // Header fields recorded on invoice_mfg. Free text, all optional —
  // they're what the document said, not something the app derives, so an
  // unreadable scan shouldn't block the inwarding.
  currency:        optionalText(10),
  eway_bill_no:    optionalText(50),
  vehicle_no:      optionalText(50),
  po_ref:          optionalText(100),
  seller_gstin:    optionalText(20),
  buyer_gstin:     optionalText(20),
  bill_to_name:    optionalText(255),
  bill_to_address: optionalText(2000),
  bill_to_state:   optionalText(100),
  ship_to_name:    optionalText(255),
  ship_to_address: optionalText(2000),
  invoice_total:   z.union([z.number(), z.string()]).optional().nullable(),

  line_items: z
    .array(
      z.object({
        sku_code:     z.string().trim().min(1, "Every line item needs a mapped SKU."),
        qty:          z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, {
          message: "Quantity must be greater than 0.",
        }),
        unit_price:   z.union([z.number(), z.string()]).optional().nullable(),
        total_amount: z.union([z.number(), z.string()]).optional().nullable(),
        /**
         * The existing PO this line is received against. Mandatory: every inward
         * line books against an order the FIFO match picked, so there is no
         * "raise an inward PO for goods nobody ordered" path through this
         * endpoint. Was optional until 2026-08-07 — see
         * docs/superpowers/specs/2026-08-07-invoice-fifo-matching-plan.md.
         */
        reference_po_id: z.coerce.number().int().positive({
          message: "Every line item needs a reference PO.",
        }),

        // Recorded verbatim on invoice_items_mfg.
        parsed_sku_code: optionalText(100),
        sku_name:        optionalText(500),
        batch:           optionalText(100),
        mfg_date:        optionalText(20),
        expiry:          optionalText(20),
        hsn:             optionalText(20),
        rate:            z.union([z.number(), z.string()]).optional().nullable(),
        mrp:             z.union([z.number(), z.string()]).optional().nullable(),
        discount:        z.union([z.number(), z.string()]).optional().nullable(),
        gst_percent:     z.union([z.number(), z.string()]).optional().nullable(),
        amount:          z.union([z.number(), z.string()]).optional().nullable(),
      })
    )
    .min(1, "At least one line item is required."),
})
  /**
   * The lines must account for the invoice's own printed total.
   *
   * Server-side as well as in the dialog, for the usual reason: the dialog
   * greying out a button is never the guard. This endpoint takes a JSON body.
   *
   * Grossing each line by its OWN gst_percent, rather than trusting
   * `total_amount`: the parser frequently writes the taxable figure into both
   * `amount` and `total_amount`, so treating the latter as tax-inclusive
   * understates the sum by the GST and would reject healthy invoices. This is
   * the same formula scripts/_check-invoice-reconciliation.ts uses, which runs
   * clean over all 65 live invoices — the 4 it flags are genuinely short.
   *
   * Charges (freight) are inside the printed total but are not posted, so they
   * land inside MATCH_TOLERANCE rather than being added back. That is what the
   * 2% band is absorbing; a manufacturer billing heavy freight would need the
   * charge total sent up before this could be tightened.
   */
  .superRefine((inv, ctx) => {
    const total = Number(inv.invoice_total)
    if (!Number.isFinite(total) || total <= 0) return // nothing to reconcile against

    const accounted = inv.line_items.reduce((sum, li) => {
      const amount = Number(li.amount ?? li.total_amount ?? 0)
      if (!Number.isFinite(amount)) return sum
      const gst = Number(li.gst_percent ?? 0)
      return sum + amount * (1 + (Number.isFinite(gst) ? gst : 0) / 100)
    }, 0)

    const gap = Math.abs(total - accounted)
    if (gap <= total * MATCH_TOLERANCE) return

    const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["line_items"],
      message:
        `Line items come to ₹${money(accounted)} but the invoice total is ₹${money(total)} — ` +
        `₹${money(gap)} ${total > accounted ? "unaccounted" : "over"}. ` +
        `Every line on the invoice must be recorded, even if its PO is exhausted.`,
    })
  })

export const poSendMailSchema = z.object({
  po_ids: z.array(z.union([z.number(), z.string()])).min(1, "Select at least one PO to send mail for."),
})

export type PoBulk = z.infer<typeof poBulkSchema>
export type PoCreate = z.infer<typeof poCreateSchema>
export type PoSendMail = z.infer<typeof poSendMailSchema>
export type InvoiceInward = z.infer<typeof invoiceInwardSchema>
