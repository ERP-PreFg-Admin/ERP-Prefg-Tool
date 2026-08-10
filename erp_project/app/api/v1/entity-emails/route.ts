// API route for the entity_emails contact list (vendor/manufacturer/warehouse
// email by purpose — a warehouse is keyed by its master_warehouse.name).
//
// POST /api/entity-emails → { entity_type, entity_code, emails: [{ email, purpose? }, ...] }
//   — direct insert (one row per email, same entity), no approval flow (this is an
//   auxiliary contact list, not a master-record edit). Lets one manufacturer/vendor
//   have several emails on file (e.g. one per purpose).
// Listing happens server-side in app/po-tracking/po-procurement/entity-emails/page.tsx.
import { NextResponse } from "next/server"
import { execute } from "@/lib/db"
import { entityEmails } from "@/lib/queries/entity-emails"
import { withGateway } from "@/lib/gateway/with-gateway"
import { entityEmailCreateSchema } from "@/lib/validation/entity-emails"

export const POST = withGateway({
  schema: entityEmailCreateSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body }) => {
    for (const { email, purpose } of body.emails) {
      await execute(entityEmails.insert, [body.entity_type, body.entity_code, email, purpose || null])
    }
    return NextResponse.json({ ok: true })
},
})
