import { z } from "zod"

export const entityEmailCreateSchema = z.object({
  // 'warehouse' is keyed by master_warehouse.name, which is what
  // purchase_orders.destination stores — see resolveRecipients in lib/mailer.ts.
  entity_type: z.enum(["vendor", "mfg", "warehouse"]),
  entity_code: z.string().trim().min(1),
  emails: z.array(z.object({
    email: z.string().trim().email(),
    purpose: z.string().trim().optional(),
  })).min(1),
})
