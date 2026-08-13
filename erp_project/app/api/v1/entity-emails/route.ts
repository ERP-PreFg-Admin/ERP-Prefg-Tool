// API route for the entity_emails contact list (vendor/manufacturer/warehouse
// email by purpose — a warehouse is keyed by its master_warehouse.name).
//
// POST /api/v1/entity-emails → { entity_type, entity_code, emails: [{ email, purpose? }, ...] }
//   — direct insert (one row per email, same entity), no approval flow (this is an
//   auxiliary contact list, not a master-record edit). Lets one manufacturer/vendor
//   have several emails on file (e.g. one per purpose).
// Listing happens server-side in app/po-tracking/po-procurement/entity-emails/page.tsx.
import { NextResponse } from "next/server"
import { execute, query } from "@/lib/db"
import { entityEmails } from "@/lib/queries/entity-emails"
import { warehouse as warehouseSql } from "@/lib/queries/warehouse"
import { withGateway } from "@/lib/gateway/with-gateway"
import { ApiError } from "@/lib/gateway/errors"
import { entityEmailCreateSchema } from "@/lib/validation/entity-emails"

export const POST = withGateway({
  schema: entityEmailCreateSchema,
  access: { pageSlug: "/po-tracking", level: "editor" },
  handler: async ({ body }) => {
    // Empty string, not just undefined, becomes NULL: the form's "All entities"
    // option submits "" and a literal '' would match no entity in
    // selectByWarehouseForEntity, so those addresses would silently never be
    // mailed — the exact failure this column exists to avoid.
    const legalEntityCode = body.legal_entity_code?.trim() || null

    // The column has no foreign key (entity_code points at three different
    // tables depending on entity_type, so neither column can carry one), which
    // means a typo would be accepted and then match nothing at send time.
    if (legalEntityCode) {
      const rows = await query<{ id: number }>(warehouseSql.selectEntityIdByCode, [legalEntityCode])
      if (rows.length === 0) {
        throw new ApiError(400, "unknown_entity", `Unknown legal entity '${legalEntityCode}'.`)
      }
    }

    for (const { email, purpose } of body.emails) {
      await execute(entityEmails.insert, [
        body.entity_type, body.entity_code, legalEntityCode, email, purpose || null,
      ])
    }
    return NextResponse.json({ ok: true })
},
})
