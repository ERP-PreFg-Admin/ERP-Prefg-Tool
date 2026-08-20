import { z } from "zod"

export const entityEmailCreateSchema = z
  .object({
    // 'warehouse' is keyed by master_warehouse.name, which is what
    // purchase_orders.destination stores — see resolveRecipients in lib/mail/mailer.ts.
    // 'employee' is a person to loop in rather than an entity to write to —
    // ours or an outside party (3PL, CHA, consultant), so the address is typed,
    // not picked from `users`. entity_code is then the warehouse name or
    // manufacturer code they are attached to, or '*' for every manufacturer.
    // The route checks that code against the right table.
    entity_type: z.enum(["vendor", "mfg", "warehouse", "employee"]),
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
    /** Defaults to active: a contact is added in order to be mailed. */
    status: z.enum(["active", "inactive"]).default("active"),
    emails: z
      .array(
        z.object({
          email: z.string().trim().email("Enter a valid email address, e.g. name@example.com"),
          /** Which header the address goes in. Absent = 'to', the column's
           *  default and how every row behaved before this existed. */
          recipient_type: z.enum(["to", "cc"]).default("to"),
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
  .refine(
    // '*' means "every one of these". Only warehouse and employee rows have a
    // wildcard arm in the SELECTs (lib/queries/entity-emails.ts), so accepting it
    // on a vendor or mfg row would store a contact that matches nothing and
    // silently mails no one — the failure this file exists to prevent.
    (v) => v.entity_code !== "*" || v.entity_type === "warehouse" || v.entity_type === "employee",
    {
      path: ["entity_code"],
      message: "'All' is only available for warehouse and employee contacts.",
    }
  )

/**
 * Editing one existing row.
 *
 * A single row rather than the create shape's `emails[]`: the list shows one
 * address per line, so that is what an edit acts on. Reusing the array shape
 * would make "edit" ambiguous about whether it replaces the entity's whole set.
 */
export const entityEmailUpdateSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    entity_type: z.enum(["vendor", "mfg", "warehouse", "employee"]),
    entity_code: z.string().trim().min(1),
    legal_entity_code: z.string().trim().optional(),
    email: z.string().trim().email("Enter a valid email address, e.g. name@example.com"),
    recipient_type: z.enum(["to", "cc"]).default("to"),
    purpose: z.string().trim().optional(),
    /** Deactivating stops the mail without destroying the record of who used to
     *  receive it — which deleting the row would. */
    status: z.enum(["active", "inactive"]).default("active"),
  })
  .refine((v) => !v.legal_entity_code || v.entity_type === "warehouse", {
    path: ["legal_entity_code"],
    message: "A legal entity can only be set on warehouse contacts.",
  })
  .refine(
    (v) => v.entity_code !== "*" || v.entity_type === "warehouse" || v.entity_type === "employee",
    {
      path: ["entity_code"],
      message: "'All' is only available for warehouse and employee contacts.",
    }
  )
