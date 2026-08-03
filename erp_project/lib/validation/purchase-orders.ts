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

/**
 * POST /api/purchase-orders/invoice — the reviewed, user-corrected invoice.
 *
 * Deliberately NOT an extension of poCreateSchema: that one forbids backdating
 * expected_on, and an inward PO is retroactive by definition — the goods were
 * dispatched before anyone opened this dialog.
 */
export const invoiceInwardSchema = z.object({
  attachment_key: z.string().trim().min(1, "The invoice PDF must be uploaded first."),
  invoice_no:     z.string().trim().min(1, "Invoice number is required."),
  invoice_date:   z.string().trim().optional().nullable(),
  mfg_id:         z.union([z.number(), z.string()]).refine((v) => String(v).trim().length > 0, {
    message: "Manufacturer is required.",
  }),
  destination:    z.string().trim().min(1, "Destination is required."),
  line_items: z
    .array(
      z.object({
        sku_code:     z.string().trim().min(1, "Every line item needs a mapped SKU."),
        qty:          z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, {
          message: "Quantity must be greater than 0.",
        }),
        unit_price:   z.union([z.number(), z.string()]).optional().nullable(),
        total_amount: z.union([z.number(), z.string()]).optional().nullable(),
        /** When set, the line books a receipt against that existing PO instead
         *  of creating a new inward PO. */
        reference_po_id: z.coerce.number().int().positive().optional().nullable(),
      })
    )
    .min(1, "At least one line item is required."),
})

export const poSendMailSchema = z.object({
  po_ids: z.array(z.union([z.number(), z.string()])).min(1, "Select at least one PO to send mail for."),
})

export type PoBulk = z.infer<typeof poBulkSchema>
export type PoCreate = z.infer<typeof poCreateSchema>
export type PoSendMail = z.infer<typeof poSendMailSchema>
export type InvoiceInward = z.infer<typeof invoiceInwardSchema>
