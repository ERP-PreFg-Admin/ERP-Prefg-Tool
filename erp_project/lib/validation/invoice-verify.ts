// Zod for the three-way leg verification route.

import { z } from "zod"

export const invoiceIdParamSchema = z.object({ id: z.coerce.number().int().positive() })

/** The three legs, matching invoice_leg_verification.leg's ENUM exactly — an
 *  unknown value there stores silently or errors, never what was meant. */
export const legSchema = z.enum(["po", "pod", "inv"])

export const legVerifySchema = z.object({
  leg: legSchema,
  /** false withdraws the sign-off, which deletes the row. */
  verified: z.boolean(),
  // Optional: forcing a sentence on every click buys noise, not evidence.
  remarks: z.string().trim().max(500).optional().nullable(),
})

/** Matches invoice_payment.status's ENUM — only the states a person can set. */
export const manualPaymentStatusSchema = z.enum(["pending", "initiated", "approved", "completed"])

export const paymentSchema = z.object({
  /** null hands the invoice back to the state derived from the match. */
  status: manualPaymentStatusSchema.nullable(),
  /** Free text: UTR formats differ per channel and bank, and a guessed pattern
   *  would reject a real reference at the worst possible moment. The route
   *  refuses 'completed' without one. */
  utr: z.string().trim().max(64).optional().nullable(),
  remarks: z.string().trim().max(500).optional().nullable(),
})
