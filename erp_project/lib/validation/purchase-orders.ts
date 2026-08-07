import { z } from "zod"

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
    // BOM belongs to this SKU and this manufacturer.
    bom_id: z.coerce.number().int().positive("BOM is required."),
    qty: z.union([z.number(), z.string()]),
    unit_price: z.union([z.number(), z.string()]).optional().nullable(),
    total_amount: z.union([z.number(), z.string()]).optional().nullable(),
    expected_on: z.string().trim().optional().nullable(),
    destination: z.string().trim().optional().nullable(),
    reason: z.string().trim().optional().nullable(),
    po_type: z.enum(["normal", "impromptu"]).optional().default("impromptu"),
  })
  .refine((v) => Number(v.qty) > 0, {
    message: "Quantity must be greater than 0.",
    path: ["qty"],
  })
  .refine(
    (v) => {
      if (!v.expected_on) return true
      const today = new Date().toISOString().slice(0, 10)
      return v.expected_on >= today
    },
    { message: "Backdating is not allowed for expected dispatch date.", path: ["expected_on"] }
  )
  .refine(
    (v) => v.po_type !== "impromptu" || (v.reason?.trim() ?? "").length > 0,
    { message: "Remarks are required for Impromptu POs.", path: ["reason"] }
  )

export const poActionSchema = z.union([poBulkSchema, poCreateSchema])

// /api/purchase-orders/invoice/parse takes the PDF as multipart/form-data and
// validates it in the route — nothing is in S3 at parse time, so there's no key
// to schema-check here.

/** Optional free-text field off a document: trimmed, length-capped to match the
 *  column, and normalised to null so an empty input doesn't store "". */
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().nullable()
    .transform((v): string | null => (v ? v : null))

/**
 * POST /api/purchase-orders/invoice — the reviewed, user-corrected invoice.
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

  // Header fields recorded on supplier_invoices. Free text, all optional —
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
        // Not required when the line is received against an existing PO: that
        // receipt is keyed by PO id and never needs a SKU mapping.
        sku_code:     z.string().trim().optional().nullable(),
        qty:          z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, {
          message: "Quantity must be greater than 0.",
        }),
        unit_price:   z.union([z.number(), z.string()]).optional().nullable(),
        total_amount: z.union([z.number(), z.string()]).optional().nullable(),
        /** When set, the line books a receipt against that existing PO instead
         *  of creating a new inward PO. */
        reference_po_id: z.coerce.number().int().positive().optional().nullable(),

        // Recorded verbatim on supplier_invoice_items.
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
    .min(1, "At least one line item is required.")
    .superRefine((items, ctx) => {
      // A line either creates a PO (needs a SKU) or receives against one.
      items.forEach((li, i) => {
        if (!li.reference_po_id && !li.sku_code?.trim()) {
          ctx.addIssue({
            code: "custom",
            path: [i, "sku_code"],
            message: "Every line item needs a mapped SKU or a reference PO.",
          })
        }
      })
    }),
})

export const poSendMailSchema = z.object({
  po_ids: z.array(z.union([z.number(), z.string()])).min(1, "Select at least one PO to send mail for."),
})

export type PoBulk = z.infer<typeof poBulkSchema>
export type PoCreate = z.infer<typeof poCreateSchema>
export type PoSendMail = z.infer<typeof poSendMailSchema>
export type InvoiceInward = z.infer<typeof invoiceInwardSchema>
