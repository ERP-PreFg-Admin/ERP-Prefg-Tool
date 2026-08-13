import { z } from "zod"

export const entityEmailCreateSchema = z
  .object({
    // 'warehouse' is keyed by master_warehouse.name, which is what
    // purchase_orders.destination stores — see resolveRecipients in lib/mailer.ts.
    entity_type: z.enum(["vendor", "mfg", "warehouse"]),
    entity_code: z.string().trim().min(1),
    /**
     * master_entity.code — which of OUR legal entities these addresses serve.
     * Omitted or empty means "every entity", which is how every row behaved
     * before this existed.
     *
     * Warehouse-only: a site's point of contact can differ for Pep vs Kreative,
     * whereas a vendor or manufacturer deals with us as one company. The refine
     * below enforces that; the route additionally checks the code exists.
     */
    legal_entity_code: z.string().trim().optional(),
    emails: z
      .array(
        z.object({
          email: z.string().trim().email(),
          purpose: z.string().trim().optional(),
        })
      )
      .min(1),
  })
  .refine(
    (v) => !v.legal_entity_code || v.entity_type === "warehouse",
    {
      path: ["legal_entity_code"],
      message: "A legal entity can only be set on warehouse contacts.",
    }
  )
