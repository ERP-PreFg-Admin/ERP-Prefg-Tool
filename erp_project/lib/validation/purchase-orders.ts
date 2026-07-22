import { z } from "zod"

export const poBulkCsvSchema = z.object({
  action: z.literal("bulk_csv"),
  key: z.string().trim().min(1),
  filename: z.string().trim().min(1),
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

export const poActionSchema = z.union([poBulkCsvSchema, poCreateSchema])

export const poSendMailSchema = z.object({
  po_ids: z.array(z.union([z.number(), z.string()])).min(1, "Select at least one PO to send mail for."),
})

export type PoBulkCsv = z.infer<typeof poBulkCsvSchema>
export type PoCreate = z.infer<typeof poCreateSchema>
export type PoSendMail = z.infer<typeof poSendMailSchema>
