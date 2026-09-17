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
